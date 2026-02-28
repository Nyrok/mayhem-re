#!/usr/bin/env python3
"""
algebraicCracker.py — Algebraic/probabilistic xorshift128+ cracker for 1-bit observations.

Instead of encoding the full carry chain (which makes SAT intractable), we use
an approximate linear model:

  MSB(a + b) ≈ MSB(a) XOR MSB(b)   [ignoring carry into MSB]

This approximation is correct when carry_into_bit_63 = 0, which happens ~50%
of the time for random inputs. With N observations, ~N/2 are "correct" under
the approximation.

Strategy:
1. Build GF(2) system: for each observation, one linear equation over 128 unknowns
   (the initial state bits)
2. Use Gaussian elimination to find the solution space
3. If the system is overdetermined enough (N >> 128), the true state should be
   the one that satisfies the most equations
4. For error-correcting: use random subsets of equations, solve, and check against
   ALL observations. The correct state matches ~50% + epsilon.

Actually, a better approach: use INFORMATION FROM ALL BITS, not just MSB.

Key insight: MSB(a+b) = MSB(a) XOR MSB(b) XOR carry_63
And carry_63 depends on bits 0-62 of a and b.

So the MSB observation gives us:
  observed = a[63] XOR b[63] XOR carry_63(a[0:62], b[0:62])

Where a[j] and b[j] are known linear functions of the 128 initial state bits.

Approach: Approximate GF(2) with error correction
- Set up linear system ignoring carry (N equations, 128 unknowns)
- ~50% of equations are "wrong" due to carry
- This is a decoding problem! Like decoding a random linear code with ~50% errors.
- Use: random subset selection (pick 128 equations, solve, verify)
- With N=300 observations and 128 unknowns, pick random 128 equations, solve,
  check against all 300. If >200 match, likely correct.
- P(all 128 selected equations are carry-free) = 0.5^128 ≈ 0 → this fails!

Better approach: BIT SLICING
- We know each bit of state_n is a LINEAR function of initial state bits.
- The MSB of (a+b) depends on ALL bits, but with decreasing influence.
- UPPER bits have LESS carry noise than lower bits.
- Specifically: the carry into bit 63 is the carry OUT of bit 62.
  The carry out of bit 62 = MAJ(a[62], b[62], carry_in_62)
  = MAJ(linear_62, linear_62, carry_in_62)

  The carry propagates from bit 0 upward. For RANDOM a,b:
  P(carry out of bit k = 1) = 0.5 for large k (converges quickly).

  But the carry is NOT random — it's a deterministic function of lower bits
  of the state. If we could fix the lower bits, the upper bits become linear.

APPROACH: TOP-DOWN BIT FIXING
1. Ignore carry entirely → get approximate state (50% accuracy)
2. Use the approximate state to compute what the carry SHOULD be
3. Correct the linear system by subtracting the estimated carry
4. Re-solve with corrected system
5. Iterate until convergence

Actually, let me try the simplest thing first: pure GF(2) linear algebra
ignoring carry, then verify how many predictions are correct.

Usage:
    python3 tools/algebraicCracker.py --test    # self-test
    python3 tools/algebraicCracker.py            # load from data
"""

import sys
import os
import json
import time
import random

# ============================================================================
# GF(2) Linear Algebra
# ============================================================================

MASK64 = (1 << 64) - 1
MASK128 = (1 << 128) - 1


def build_xorshift128p_matrix():
    """Build 128x128 GF(2) transition matrix for xorshift128+.
    State layout: bits [0..63] = s0, bits [64..127] = s1.
    """
    M = [0] * 128

    # new_s0 = old_s1
    for i in range(64):
        M[i] = 1 << (64 + i)

    # new_s1: simulate symbolically
    s1_sym = [1 << j for j in range(64)]           # _s1 = old_s0
    s0_sym = [1 << (64 + j) for j in range(64)]    # _s0 = old_s1

    # _s1 ^= _s1 << 23
    shifted = [0] * 64
    for j in range(23, 64):
        shifted[j] = s1_sym[j - 23]
    s1_sym = [s1_sym[j] ^ shifted[j] for j in range(64)]

    # _s1 ^= _s1 >> 17
    shifted = [0] * 64
    for j in range(64 - 17):
        shifted[j] = s1_sym[j + 17]
    s1_sym = [s1_sym[j] ^ shifted[j] for j in range(64)]

    # _s1 ^= _s0
    s1_sym = [s1_sym[j] ^ s0_sym[j] for j in range(64)]

    # _s1 ^= _s0 >> 26
    shifted = [0] * 64
    for j in range(64 - 26):
        shifted[j] = s0_sym[j + 26]
    s1_sym = [s1_sym[j] ^ shifted[j] for j in range(64)]

    for j in range(64):
        M[64 + j] = s1_sym[j]

    return M


def mat_identity(n):
    return [1 << i for i in range(n)]

def mat_mul(A, B, n):
    BT = [0] * n
    for j in range(n):
        for k in range(n):
            if (B[j] >> k) & 1:
                BT[k] |= (1 << j)
    result = [0] * n
    for i in range(n):
        for j in range(n):
            if bin(A[i] & BT[j]).count('1') & 1:
                result[i] |= (1 << j)
    return result

def mat_pow(M, exp, n):
    result = mat_identity(n)
    base = M[:]
    while exp > 0:
        if exp & 1:
            result = mat_mul(result, base, n)
        base = mat_mul(base, base, n)
        exp >>= 1
    return result

def mat_vec_mul(M, v, n):
    result = 0
    for i in range(n):
        if bin(M[i] & v).count('1') & 1:
            result |= (1 << i)
    return result


# ============================================================================
# Native xorshift128+
# ============================================================================

def xs128p_step(s0, s1):
    _s1 = s0
    _s0 = s1
    new_s0 = _s0
    _s1 ^= (_s1 << 23) & MASK64
    _s1 ^= (_s1 >> 17)
    _s1 ^= _s0
    _s1 ^= (_s0 >> 26)
    new_s1 = _s1
    output = (new_s0 + new_s1) & MASK64
    return new_s0, new_s1, output

def output_to_bit(output):
    return 1 if (output >> 12) * (2 ** -52) >= 0.5 else 0

def generate_sequence(s0, s1, n):
    bits = []
    for _ in range(n):
        s0, s1, output = xs128p_step(s0, s1)
        bits.append(output_to_bit(output))
    return bits, s0, s1


# ============================================================================
# Approach 1: Pure GF(2) ignoring carry (baseline)
# ============================================================================

def build_linear_system(M_base, n_obs):
    """Build the linear system for n_obs observations.

    For observation i (1-indexed), after i steps:
      state_i = M^i * state_0
      s0_i = state_i[0:63], s1_i = state_i[64:127]
      output_i = s0_i + s1_i

    Ignoring carry: MSB(output) ≈ MSB(s0_i) XOR MSB(s1_i)
                   = state_i[63] XOR state_i[127]
                   = (row 63 of M^i) XOR (row 127 of M^i) dotted with state_0

    Returns: list of 128-bit coefficient vectors (one per observation)
    """
    equations = []
    for step in range(1, n_obs + 1):
        Mi = mat_pow(M_base, step, 128)
        # Coefficient = row_63 XOR row_127 of M^i
        coeff = Mi[63] ^ Mi[127]
        equations.append(coeff)
    return equations


def gaussian_elimination(equations, rhs, n_vars):
    """Solve a system of GF(2) linear equations via Gaussian elimination.

    equations: list of n_vars-bit coefficient vectors
    rhs: list of 0/1 values (right-hand side)
    n_vars: number of variables (128)

    Returns: solution vector (128-bit int) or None if inconsistent.
    Also returns the rank.
    """
    n_eq = len(equations)
    # Augmented matrix: coefficient | rhs_bit
    rows = []
    for i in range(n_eq):
        # Store augmented row as (coeff, rhs_bit)
        rows.append((equations[i], rhs[i]))

    # Forward elimination
    pivot_row = 0
    pivot_cols = []
    for col in range(n_vars):
        # Find row with 1 in this column at or below pivot_row
        found = None
        for r in range(pivot_row, n_eq):
            if (rows[r][0] >> col) & 1:
                found = r
                break
        if found is None:
            continue  # Free variable

        # Swap
        rows[pivot_row], rows[found] = rows[found], rows[pivot_row]
        pivot_cols.append(col)

        # Eliminate
        for r in range(n_eq):
            if r != pivot_row and (rows[r][0] >> col) & 1:
                rows[r] = (rows[r][0] ^ rows[pivot_row][0], rows[r][1] ^ rows[pivot_row][1])

        pivot_row += 1

    rank = pivot_row

    # Back-substitution: each pivot column has exactly one 1 in its pivot row
    solution = 0
    for i, col in enumerate(pivot_cols):
        if rows[i][1]:
            solution |= (1 << col)

    return solution, rank


def solve_approx_linear(observed_bits, M_base):
    """Solve using pure GF(2) approximation (ignoring carry).

    Returns candidate state and statistics.
    """
    N = len(observed_bits)
    print(f"  Building linear system for {N} observations...")
    t0 = time.time()
    equations = build_linear_system(M_base, N)
    print(f"  System built in {time.time()-t0:.1f}s")

    # Solve
    t0 = time.time()
    solution, rank = gaussian_elimination(equations, observed_bits, 128)
    print(f"  Gaussian elimination: rank={rank}/128, time={time.time()-t0:.3f}s")

    # Verify against all observations
    s0 = solution & MASK64
    s1 = (solution >> 64) & MASK64
    predicted, _, _ = generate_sequence(s0, s1, N)
    matches = sum(1 for a, b in zip(predicted, observed_bits) if a == b)

    return s0, s1, matches, N, rank


# ============================================================================
# Approach 2: Iterative carry correction
# ============================================================================

def solve_iterative(observed_bits, M_base, max_iter=20):
    """Iteratively solve by estimating carry and correcting.

    1. Start with GF(2) approximation (carry = 0 everywhere)
    2. Use recovered state to compute actual carries
    3. Flip the RHS bits where carry was 1 (correcting the approximation)
    4. Re-solve the corrected system
    5. Repeat until stable
    """
    N = len(observed_bits)
    equations = build_linear_system(M_base, N)

    corrected_rhs = list(observed_bits)  # Start with original
    best_state = None
    best_matches = 0

    for iteration in range(max_iter):
        # Solve corrected system
        solution, rank = gaussian_elimination(equations, corrected_rhs, 128)
        s0 = solution & MASK64
        s1 = (solution >> 64) & MASK64

        # Generate predictions and check
        predicted, _, _ = generate_sequence(s0, s1, N)
        matches = sum(1 for a, b in zip(predicted, observed_bits) if a == b)

        if matches > best_matches:
            best_matches = matches
            best_state = (s0, s1)

        print(f"  Iter {iteration}: matches={matches}/{N} ({matches/N*100:.1f}%) rank={rank}")

        if matches == N:
            print(f"  PERFECT MATCH at iteration {iteration}!")
            return s0, s1, matches, N

        if iteration > 0 and matches <= prev_matches:
            # Not improving, try random perturbation
            pass
        prev_matches = matches

        # Compute actual carries for the current state estimate
        # Then correct the RHS: corrected_rhs[i] = observed[i] XOR carry[i]
        ts0, ts1 = s0, s1
        for i in range(N):
            ts0, ts1, output = xs128p_step(ts0, ts1)
            # The carry into bit 63 = MSB(output) XOR MSB(ts0_prev+1) XOR MSB(ts1_prev+1)
            # Actually: MSB(a+b) = a[63] XOR b[63] XOR carry_63
            # carry_63 = MSB(a+b) XOR a[63] XOR b[63]
            actual_msb = (output >> 63) & 1

            # Get the state BEFORE this step was computed to get a, b
            # We need to re-run from scratch for each step to get pre-step state
            pass

        # Simpler: compute carries from scratch
        ts0, ts1 = s0, s1  # Initial state estimate
        new_rhs = []
        for i in range(N):
            # State before step
            pre_s0, pre_s1 = ts0, ts1
            ts0, ts1, output = xs128p_step(ts0, ts1)

            # After step: new_s0 = pre_s1, new_s1 = computed
            # output = new_s0 + new_s1
            new_s0 = ts0  # = pre_s1
            new_s1 = ts1

            # MSB of (new_s0 + new_s1) = msb(new_s0) XOR msb(new_s1) XOR carry_63
            msb_a = (new_s0 >> 63) & 1
            msb_b = (new_s1 >> 63) & 1
            actual_msb = (output >> 63) & 1
            carry_63 = actual_msb ^ msb_a ^ msb_b

            # The linear equation says: eq[i] · state = msb_a XOR msb_b
            # The truth is: eq[i] · state = observed[i] XOR carry_63
            # So corrected_rhs[i] = observed[i] XOR carry_63
            new_rhs.append(observed_bits[i] ^ carry_63)

        corrected_rhs = new_rhs

    if best_state:
        return best_state[0], best_state[1], best_matches, N
    return None, None, 0, N


# ============================================================================
# Approach 3: Random subset search
# ============================================================================

def solve_random_subsets(observed_bits, M_base, n_trials=10000):
    """Try random subsets of 128 equations and check solutions.

    For each trial:
    1. Pick 128 random equations from N available
    2. Solve the 128x128 GF(2) system
    3. Check how many of ALL N observations the solution matches
    4. Keep the best

    Since ~50% of equations have carry errors, P(all 128 correct) = 2^-128.
    This WON'T work for pure random subsets.

    Better: pick equations and RANDOMLY FLIP some RHS bits.
    With 50% error rate, flipping each bit with 50% chance creates a
    distribution centered on the correct answer. But this is just random...

    Actually, MUCH better approach: use the ITERATIVE method above,
    or use majority decoding:
    - For each of the 128 unknowns, use parity equations to "vote"
    - Each equation that's carry-free gives a correct vote
    """
    N = len(observed_bits)
    print(f"  Building equations for random subset search ({N} observations)...")
    equations = build_linear_system(M_base, N)

    best_state = None
    best_matches = 0
    indices = list(range(N))

    for trial in range(n_trials):
        # Pick random 128 equations
        subset = random.sample(indices, min(128, N))
        sub_eqs = [equations[i] for i in subset]
        sub_rhs = [observed_bits[i] for i in subset]

        solution, rank = gaussian_elimination(sub_eqs, sub_rhs, 128)
        if rank < 128:
            continue  # Underdetermined

        s0 = solution & MASK64
        s1 = (solution >> 64) & MASK64

        predicted, _, _ = generate_sequence(s0, s1, N)
        matches = sum(1 for a, b in zip(predicted, observed_bits) if a == b)

        if matches > best_matches:
            best_matches = matches
            best_state = (s0, s1)
            if trial % 100 == 0 or matches > N * 0.6:
                print(f"  Trial {trial}: {matches}/{N} ({matches/N*100:.1f}%)")

        if matches == N:
            print(f"  PERFECT MATCH at trial {trial}!")
            return s0, s1, matches, N

    if best_state:
        return best_state[0], best_state[1], best_matches, N
    return None, None, 0, N


# ============================================================================
# Self-test
# ============================================================================

def self_test():
    print("=" * 65)
    print(" ALGEBRAIC CRACKER — Self-test")
    print("=" * 65)

    M = build_xorshift128p_matrix()

    # Verify matrix
    print("\n--- Matrix verification ---")
    for _ in range(100):
        s0 = random.getrandbits(64)
        s1 = random.getrandbits(64) | 1
        vec = s0 | (s1 << 64)
        new_vec = mat_vec_mul(M, vec, 128)
        ns0, ns1, _ = xs128p_step(s0, s1)
        assert (new_vec & MASK64) == ns0 and ((new_vec >> 64) & MASK64) == ns1
    print("  100/100 matrix checks pass.")

    # Test carry approximation accuracy
    print("\n--- Carry approximation accuracy ---")
    s0 = random.getrandbits(64) | 1
    s1 = random.getrandbits(64) | 1
    N_test = 1000
    carry_free = 0
    ts0, ts1 = s0, s1
    for _ in range(N_test):
        pre_s0, pre_s1 = ts0, ts1
        ts0, ts1, output = xs128p_step(pre_s0, pre_s1)
        msb_a = (ts0 >> 63) & 1
        msb_b = (ts1 >> 63) & 1
        actual_msb = (output >> 63) & 1
        carry = actual_msb ^ msb_a ^ msb_b
        if carry == 0:
            carry_free += 1
    print(f"  Carry-free observations: {carry_free}/{N_test} ({carry_free/N_test*100:.1f}%)")
    print(f"  (Expected ~50% for random state pairs)")

    # Test all approaches
    for n_bits in [150, 200, 300]:
        s0 = random.getrandbits(64) | 1
        s1 = random.getrandbits(64) | 1
        bits, _, _ = generate_sequence(s0, s1, n_bits)

        print(f"\n{'='*65}")
        print(f" Testing with {n_bits} bits (known seed)")
        print(f" s0=0x{s0:016x}, s1=0x{s1:016x}")
        print(f"{'='*65}")

        # Approach 1: Pure linear
        print(f"\n--- Approach 1: Pure GF(2) (ignoring carry) ---")
        rs0, rs1, matches, total, rank = solve_approx_linear(bits, M)
        print(f"  Result: {matches}/{total} ({matches/total*100:.1f}%) rank={rank}")
        exact = rs0 == s0 and rs1 == s1
        print(f"  Exact match: {exact}")

        # Approach 2: Iterative
        print(f"\n--- Approach 2: Iterative carry correction ---")
        rs0, rs1, matches, total = solve_iterative(bits, M, max_iter=10)
        print(f"  Best: {matches}/{total} ({matches/total*100:.1f}%)")
        exact = rs0 == s0 and rs1 == s1
        print(f"  Exact match: {exact}")

        # Approach 3: Random subsets (quick test)
        if n_bits >= 200:
            print(f"\n--- Approach 3: Random subsets (1000 trials) ---")
            rs0, rs1, matches, total = solve_random_subsets(bits, M, n_trials=1000)
            print(f"  Best: {matches}/{total} ({matches/total*100:.1f}%)")
            exact = rs0 == s0 and rs1 == s1
            print(f"  Exact match: {exact}")


# ============================================================================
# Load real data
# ============================================================================

def load_chronological_bits():
    data_file = os.path.join(os.path.dirname(__file__), '..', 'analysis', 'chronological_trades.json')
    with open(data_file) as f:
        data = json.load(f)
    bits = [t['bit'] for t in data['trades']]
    return bits, data['trades']


# ============================================================================
# Main
# ============================================================================

if __name__ == '__main__':
    if '--test' in sys.argv:
        self_test()
    else:
        print("Loading chronological trades...")
        bits, trades = load_chronological_bits()
        print(f"Loaded {len(bits)} trades")

        M = build_xorshift128p_matrix()

        print(f"\n--- Approach 1: Pure GF(2) (all {len(bits)} trades) ---")
        rs0, rs1, matches, total, rank = solve_approx_linear(bits, M)
        print(f"  Matches: {matches}/{total} ({matches/total*100:.1f}%)")

        print(f"\n--- Approach 2: Iterative correction ---")
        rs0, rs1, matches, total = solve_iterative(bits, M, max_iter=15)
        print(f"  Best: {matches}/{total} ({matches/total*100:.1f}%)")
