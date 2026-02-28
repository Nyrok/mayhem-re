#!/usr/bin/env python3
"""
satCracker.py -- SAT-based xorshift128+ cracker for 1-bit observations.

Cracks V8's xorshift128+ PRNG from 1-bit observations (buy=0, sell=1)
using a direct CNF encoding with pysat.

Key insight: xorshift128+ state transitions are LINEAR over GF(2) (only
XOR and shift). The only non-linear part is the addition output = s0 + s1
which produces carries. We encode the linear part via a 128x128 binary
transition matrix and the addition via a ripple-carry adder in CNF.

Usage:
    python3 tools/satCracker.py --test              # self-test with known seeds
    python3 tools/satCracker.py --bits=010011...     # crack from bit string
    python3 tools/satCracker.py                      # load chronological_trades.json

Algorithm:
    1. Build 128x128 GF(2) transition matrix M for xorshift128+
    2. For observation n, compute M^n to get each bit of state_n as
       XOR of specific bits of the initial state (128 vars)
    3. Encode 64-bit ripple-carry adder for output = s0_n + s1_n
       using Tseitin transformation (AND, OR, XOR -> CNF clauses)
    4. Constrain MSB(output) = observed_bit
    5. Solve with CaDiCaL (fastest available SAT solver in pysat)
"""

import json
import sys
import os
import time
import random
from pysat.solvers import Cadical195, Glucose4
from pysat.formula import CNF


# ============================================================================
# 1. GF(2) Matrix Operations
# ============================================================================
# We represent a 128x128 binary matrix as a list of 128 integers, where each
# integer is a 128-bit bitmask representing one row.  Bit j of row i means
# "new_bit_i depends on old_bit_j" (XOR dependency).

def mat_identity(n):
    """Return n x n identity matrix over GF(2)."""
    return [1 << i for i in range(n)]


def mat_mul(A, B, n):
    """Multiply two n x n GF(2) matrices. A[i] and B[j] are row bitmasks."""
    # Transpose B for fast column access
    BT = [0] * n
    for j in range(n):
        for k in range(n):
            if (B[j] >> k) & 1:
                BT[k] |= (1 << j)
    result = [0] * n
    for i in range(n):
        row = 0
        for j in range(n):
            # dot product of A[i] and column j of B = A[i] AND BT[j], popcount mod 2
            bits = A[i] & BT[j]
            if bin(bits).count('1') & 1:
                row |= (1 << j)
        result[i] = row
    return result


def mat_vec_mul(M, v, n):
    """Multiply n x n GF(2) matrix M by n-bit vector v (integer bitmask).
    Returns n-bit result vector."""
    result = 0
    for i in range(n):
        # Row i of M dotted with v
        bits = M[i] & v
        if bin(bits).count('1') & 1:
            result |= (1 << i)
    return result


def mat_pow(M, exp, n):
    """Compute M^exp over GF(2) using binary exponentiation."""
    result = mat_identity(n)
    base = M[:]
    while exp > 0:
        if exp & 1:
            result = mat_mul(result, base, n)
        base = mat_mul(base, base, n)
        exp >>= 1
    return result


# ============================================================================
# 2. Xorshift128+ Transition Matrix
# ============================================================================
# State vector layout (128 bits):
#   bits [0..63]   = s0[0..63]   (s0[0] = LSB, s0[63] = MSB)
#   bits [64..127] = s1[0..63]   (s1[0] = LSB, s1[63] = MSB)
#
# V8's xorshift128+ step:
#   _s1 = s0          (copy old s0 into working _s1)
#   _s0 = s1          (copy old s1 into working _s0)
#   new_s0 = _s0      (= old s1)
#   _s1 ^= _s1 << 23
#   _s1 ^= _s1 >> 17  (logical shift)
#   _s1 ^= _s0
#   _s1 ^= _s0 >> 26  (logical shift)
#   new_s1 = _s1
#
# We build the transition matrix row by row. Row i tells us which input
# bits XOR together to produce output bit i.

def build_xorshift128p_matrix():
    """Build the 128x128 GF(2) transition matrix for one xorshift128+ step.

    Input state:  [s0_0, ..., s0_63, s1_0, ..., s1_63]
    Output state: [new_s0_0, ..., new_s0_63, new_s1_0, ..., new_s1_63]
    """
    M = [0] * 128

    # new_s0 = old_s1  (bits 64..127 of input map to bits 0..63 of output)
    for i in range(64):
        M[i] = 1 << (64 + i)  # new_s0[i] = old_s1[i]

    # new_s1 computation:
    # _s1 = old_s0
    # _s0 = old_s1
    # Start with _s1 = old_s0 (bits 0..63 of input)
    #
    # _s1 ^= _s1 << 23:
    #   For bit j of result: _s1[j] ^= _s1[j-23] (if j >= 23)
    #   So _s1[j] = old_s0[j] XOR old_s0[j-23] (if j >= 23)
    #        _s1[j] = old_s0[j]                  (if j < 23)
    #
    # _s1 ^= _s1 >> 17 (logical shift right):
    #   After previous step, _s1 has two terms. Now _s1[j] ^= _s1[j+17]
    #   We need to expand carefully.
    #
    # It's cleanest to simulate the transformations on a symbolic 64-element
    # array where each element is a set of GF(2) dependencies.

    # Symbolic representation: for each bit position, track which input bits
    # contribute (as a bitmask over the 128 input bits).
    s1_sym = [0] * 64  # _s1 starts as old_s0
    for j in range(64):
        s1_sym[j] = 1 << j  # old_s0[j]

    s0_sym = [0] * 64  # _s0 = old_s1
    for j in range(64):
        s0_sym[j] = 1 << (64 + j)  # old_s1[j]

    # _s1 ^= _s1 << 23
    # (_s1 << 23)[j] = _s1[j-23] if j >= 23, else 0
    shifted = [0] * 64
    for j in range(23, 64):
        shifted[j] = s1_sym[j - 23]
    s1_sym = [s1_sym[j] ^ shifted[j] for j in range(64)]

    # _s1 ^= _s1 >> 17 (logical right shift)
    # (_s1 >> 17)[j] = _s1[j+17] if j+17 < 64, else 0
    shifted = [0] * 64
    for j in range(64 - 17):
        shifted[j] = s1_sym[j + 17]
    s1_sym = [s1_sym[j] ^ shifted[j] for j in range(64)]

    # _s1 ^= _s0
    s1_sym = [s1_sym[j] ^ s0_sym[j] for j in range(64)]

    # _s1 ^= _s0 >> 26 (logical right shift)
    shifted = [0] * 64
    for j in range(64 - 26):
        shifted[j] = s0_sym[j + 26]
    s1_sym = [s1_sym[j] ^ shifted[j] for j in range(64)]

    # new_s1[j] = s1_sym[j], which maps to output bits 64+j
    for j in range(64):
        M[64 + j] = s1_sym[j]

    return M


# ============================================================================
# 3. Native xorshift128+ for verification
# ============================================================================

MASK64 = (1 << 64) - 1


def xs128p_native_step(s0, s1):
    """One step of V8's xorshift128+. Returns (new_s0, new_s1, output)."""
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


def output_to_double(output):
    """Convert xorshift128+ output to a double in [0, 1) as V8 does."""
    return (output >> 12) * (2 ** -52)


def output_to_bit(output):
    """Convert output to observed bit (0 if < 0.5, 1 if >= 0.5)."""
    return 1 if output_to_double(output) >= 0.5 else 0


def generate_sequence(s0, s1, n):
    """Generate n bits from given initial state."""
    bits = []
    for _ in range(n):
        s0, s1, output = xs128p_native_step(s0, s1)
        bits.append(output_to_bit(output))
    return bits, s0, s1


# ============================================================================
# 4. Verify the GF(2) transition matrix
# ============================================================================

def verify_matrix():
    """Verify that M * state matches one native xorshift128+ step.

    We check the LINEAR part only (the state transition). The output
    involves a non-linear addition, so we verify state0/state1 after step.
    """
    M = build_xorshift128p_matrix()

    # Test with random states
    for trial in range(100):
        s0 = random.getrandbits(64)
        s1 = random.getrandbits(64)
        if s0 == 0 and s1 == 0:
            s1 = 1

        # Pack into 128-bit vector: [s0_0..s0_63, s1_0..s1_63]
        state_vec = s0 | (s1 << 64)

        # Matrix multiply
        new_vec = mat_vec_mul(M, state_vec, 128)

        # Unpack
        mat_new_s0 = new_vec & MASK64
        mat_new_s1 = (new_vec >> 64) & MASK64

        # Native step
        nat_new_s0, nat_new_s1, _ = xs128p_native_step(s0, s1)

        if mat_new_s0 != nat_new_s0 or mat_new_s1 != nat_new_s1:
            print(f"MATRIX VERIFY FAILED on trial {trial}!")
            print(f"  Input:  s0=0x{s0:016x}, s1=0x{s1:016x}")
            print(f"  Matrix: s0=0x{mat_new_s0:016x}, s1=0x{mat_new_s1:016x}")
            print(f"  Native: s0=0x{nat_new_s0:016x}, s1=0x{nat_new_s1:016x}")
            return False

    print("  Matrix verification: 100/100 random states match native step.")
    return True


def verify_matrix_power():
    """Verify M^n applied to state matches n native steps."""
    M = build_xorshift128p_matrix()

    for trial in range(10):
        s0 = random.getrandbits(64)
        s1 = random.getrandbits(64)
        if s0 == 0 and s1 == 0:
            s1 = 1

        n = random.randint(1, 50)
        Mn = mat_pow(M, n, 128)

        state_vec = s0 | (s1 << 64)
        mat_vec = mat_vec_mul(Mn, state_vec, 128)
        mat_s0 = mat_vec & MASK64
        mat_s1 = (mat_vec >> 64) & MASK64

        # n native steps
        ns0, ns1 = s0, s1
        for _ in range(n):
            ns0, ns1, _ = xs128p_native_step(ns0, ns1)

        if mat_s0 != ns0 or mat_s1 != ns1:
            print(f"MATRIX POWER VERIFY FAILED: n={n}, trial={trial}")
            return False

    print("  Matrix power verification: 10 random (state, n) pairs match.")
    return True


# ============================================================================
# 5. CNF Encoder with Tseitin Transformation
# ============================================================================

class CNFEncoder:
    """Builds a CNF formula for the xorshift128+ cracking problem.

    Variables 1..128 represent the 128 bits of the initial state:
      var 1..64   = s0[0]..s0[63]   (LSB to MSB)
      var 65..128 = s1[0]..s1[63]   (LSB to MSB)

    Additional auxiliary variables are allocated as needed for Tseitin
    encoding of XOR chains, AND gates, OR gates, and carry chains.
    """

    def __init__(self):
        self.clauses = []
        self.next_var = 129  # vars 1-128 are reserved for initial state
        self.M = build_xorshift128p_matrix()
        # Precompute matrix powers for each observation step
        self._power_cache = {}

    def new_var(self):
        """Allocate a fresh auxiliary variable."""
        v = self.next_var
        self.next_var += 1
        return v

    # ---- Tseitin gates ----

    def gate_const(self, value):
        """Return a variable forced to a constant 0 or 1."""
        v = self.new_var()
        if value:
            self.clauses.append([v])      # v must be true
        else:
            self.clauses.append([-v])     # v must be false
        return v

    def gate_and(self, a, b):
        """c = a AND b. Returns variable c."""
        c = self.new_var()
        # (~a | ~b | c), (a | ~c), (b | ~c)
        self.clauses.append([-a, -b, c])
        self.clauses.append([a, -c])
        self.clauses.append([b, -c])
        return c

    def gate_or(self, a, b):
        """c = a OR b. Returns variable c."""
        c = self.new_var()
        # (a | b | ~c), (~a | c), (~b | c)
        self.clauses.append([a, b, -c])
        self.clauses.append([-a, c])
        self.clauses.append([-b, c])
        return c

    def gate_xor2(self, a, b):
        """c = a XOR b. Returns variable c."""
        c = self.new_var()
        # (~a | ~b | ~c), (a | b | ~c), (a | ~b | c), (~a | b | c)
        self.clauses.append([-a, -b, -c])
        self.clauses.append([a, b, -c])
        self.clauses.append([a, -b, c])
        self.clauses.append([-a, b, c])
        return c

    def gate_xor_chain(self, var_list):
        """Compute XOR of a list of variables.  Returns a variable.

        For an empty list returns a constant-0 variable.
        For a single variable returns that variable (no new clauses).
        For multiple variables chains pairwise XOR gates.
        """
        if len(var_list) == 0:
            return self.gate_const(0)
        if len(var_list) == 1:
            return var_list[0]
        # Chain pairwise
        result = var_list[0]
        for v in var_list[1:]:
            result = self.gate_xor2(result, v)
        return result

    def gate_maj(self, a, b, c):
        """d = MAJ(a, b, c) = (a AND b) OR (a AND c) OR (b AND c).

        Optimized: MAJ(a,b,c) has a direct 6-clause Tseitin encoding.
          d is true iff at least 2 of {a,b,c} are true.
        Clauses:
          (a | b | ~d), (a | c | ~d), (b | c | ~d),
          (~a | ~b | d), (~a | ~c | d), (~b | ~c | d)
        """
        d = self.new_var()
        self.clauses.append([a, b, -d])
        self.clauses.append([a, c, -d])
        self.clauses.append([b, c, -d])
        self.clauses.append([-a, -b, d])
        self.clauses.append([-a, -c, d])
        self.clauses.append([-b, -c, d])
        return d

    # ---- State computation for observation n ----

    def get_power(self, n):
        """Get M^n (cached)."""
        if n not in self._power_cache:
            self._power_cache[n] = mat_pow(self.M, n, 128)
        return self._power_cache[n]

    def get_state_bit_var(self, Mn, bit_index):
        """Get a CNF variable representing bit `bit_index` of M^n * initial_state.

        Row `bit_index` of M^n tells us which initial state bits XOR together
        to produce this output bit.  We return a variable equal to that XOR.
        """
        row = Mn[bit_index]
        # Collect which initial-state variables contribute
        deps = []
        for j in range(128):
            if (row >> j) & 1:
                deps.append(j + 1)  # variables are 1-indexed

        return self.gate_xor_chain(deps)

    # ---- Add constraint for one observation ----

    def add_observation(self, step_index, observed_bit):
        """Add clauses constraining: MSB(s0_n + s1_n) = observed_bit.

        step_index: which PRNG step (1-indexed; step 1 is the first output).
        observed_bit: 0 or 1.

        After `step_index` applications of the transition, the state is
        M^step_index * initial_state. We call those s0_n and s1_n.

        output = s0_n + s1_n  (64-bit unsigned addition)
        MSB(output) = s0_n[63] XOR s1_n[63] XOR carry_into_bit_63

        The carry chain:
          carry[-1] = 0
          carry[j]  = MAJ(a[j], b[j], carry[j-1])  for j = 0..62
        where a[j] = s0_n[j], b[j] = s1_n[j].

        Each a[j] and b[j] is a XOR of initial state bits (known from M^n).
        """
        Mn = self.get_power(step_index)

        # Get variables for each bit of s0_n and s1_n
        # s0_n[j] is output bit j (0..63), s1_n[j] is output bit 64+j
        a_vars = []  # a[0..63]
        b_vars = []  # b[0..63]
        for j in range(64):
            a_vars.append(self.get_state_bit_var(Mn, j))       # s0_n[j]
            b_vars.append(self.get_state_bit_var(Mn, 64 + j))  # s1_n[j]

        # Build carry chain from bit 0 to bit 62
        # carry[0] = a[0] AND b[0]  (since carry[-1] = 0, MAJ(a,b,0) = a AND b)
        carry = self.gate_and(a_vars[0], b_vars[0])

        for j in range(1, 63):
            # carry[j] = MAJ(a[j], b[j], carry[j-1])
            carry = self.gate_maj(a_vars[j], b_vars[j], carry)

        # MSB of output = a[63] XOR b[63] XOR carry[62]
        msb = self.gate_xor2(a_vars[63], b_vars[63])
        msb = self.gate_xor2(msb, carry)

        # Constrain MSB to observed bit
        if observed_bit == 1:
            self.clauses.append([msb])
        else:
            self.clauses.append([-msb])

    def build_formula(self, observed_bits):
        """Build the full CNF formula for a sequence of observations.

        observed_bits: list of 0/1 values.
        observed_bits[0] corresponds to the output of step 1 (first PRNG call).
        """
        t_start = time.time()
        for i, bit in enumerate(observed_bits):
            step = i + 1  # 1-indexed step
            self.add_observation(step, bit)
            if (i + 1) % 10 == 0 or i == len(observed_bits) - 1:
                elapsed = time.time() - t_start
                print(f"  Encoded {i+1}/{len(observed_bits)} observations "
                      f"({self.next_var - 1} vars, {len(self.clauses)} clauses, "
                      f"{elapsed:.1f}s)")

    def solve(self, solver_name="cadical"):
        """Solve the CNF formula and return the initial state, or None."""
        print(f"\nSolving with {solver_name} "
              f"({self.next_var - 1} vars, {len(self.clauses)} clauses)...")

        t_start = time.time()

        if solver_name == "cadical":
            solver = Cadical195()
        elif solver_name == "glucose":
            solver = Glucose4()
        else:
            raise ValueError(f"Unknown solver: {solver_name}")

        for clause in self.clauses:
            solver.add_clause(clause)

        result = solver.solve()
        elapsed = time.time() - t_start

        if result:
            model = solver.get_model()
            # Extract initial state from variables 1..128
            # model is a list of signed integers; positive = true, negative = false
            model_set = set(model)
            s0 = 0
            s1 = 0
            for j in range(64):
                if (j + 1) in model_set:  # var j+1 is s0[j]
                    s0 |= (1 << j)
                if (64 + j + 1) in model_set:  # var 64+j+1 is s1[j]
                    s1 |= (1 << j)

            solver.delete()
            print(f"SOLVED in {elapsed:.1f}s!")
            print(f"  state0 = 0x{s0:016x}")
            print(f"  state1 = 0x{s1:016x}")
            return s0, s1
        else:
            solver.delete()
            print(f"UNSAT or timeout after {elapsed:.1f}s")
            return None


# ============================================================================
# 6. High-level solve wrapper
# ============================================================================

def solve_xorshift128p(observed_bits, solver_name="cadical"):
    """Solve for xorshift128+ initial state from 1-bit observations.

    Returns (s0, s1) or None.
    """
    N = len(observed_bits)
    print(f"\n{'='*65}")
    print(f" SAT Cracker: {N} observations, solver={solver_name}")
    print(f"{'='*65}")
    print(f"Sequence: {''.join(str(b) for b in observed_bits[:60])}"
          f"{'...' if N > 60 else ''}")

    encoder = CNFEncoder()
    encoder.build_formula(observed_bits)
    result = encoder.solve(solver_name)

    if result is None and solver_name == "cadical":
        print("\nCaDiCaL failed, trying Glucose4 as fallback...")
        encoder2 = CNFEncoder()
        encoder2.build_formula(observed_bits)
        result = encoder2.solve("glucose")

    return result


def verify_state(s0, s1, observed_bits):
    """Verify that recovered state reproduces the observed sequence."""
    predicted, _, _ = generate_sequence(s0, s1, len(observed_bits))
    matches = sum(1 for a, b in zip(predicted, observed_bits) if a == b)
    return matches, len(observed_bits)


# ============================================================================
# 7. Self-test
# ============================================================================

def self_test():
    """Test the full pipeline: matrix, encoding, solving, prediction."""
    print("=" * 65)
    print(" SELF-TEST: Verifying matrix, encoding, and SAT solver")
    print("=" * 65)

    # Step 1: Verify the GF(2) transition matrix
    print("\n--- Step 1: Matrix Verification ---")
    if not verify_matrix():
        print("FATAL: Matrix verification failed!")
        return False
    if not verify_matrix_power():
        print("FATAL: Matrix power verification failed!")
        return False
    print("  PASS\n")

    # Step 2: Verify Tseitin encoding on a tiny example
    print("--- Step 2: Tseitin Gate Verification ---")
    if not verify_tseitin_gates():
        print("FATAL: Tseitin gate verification failed!")
        return False
    print("  PASS\n")

    # Step 3: Crack known seeds with increasing observation counts
    print("--- Step 3: SAT Solving with Known Seeds ---\n")

    test_configs = [
        (20, 60),    # 20 bits, 60s timeout
        (50, 120),   # 50 bits, 120s timeout
        (100, 300),  # 100 bits, 300s timeout
        (200, 600),  # 200 bits, 600s timeout
    ]

    for n_bits, timeout in test_configs:
        seed_s0 = random.getrandbits(64)
        seed_s1 = random.getrandbits(64)
        if seed_s0 == 0 and seed_s1 == 0:
            seed_s1 = 1

        print(f"\n{'~'*65}")
        print(f" Test: {n_bits} bits | seed s0=0x{seed_s0:016x} s1=0x{seed_s1:016x}")
        print(f"{'~'*65}")

        observed, final_s0, final_s1 = generate_sequence(seed_s0, seed_s1, n_bits)
        print(f"Observed: {''.join(str(b) for b in observed[:60])}"
              f"{'...' if n_bits > 60 else ''}")

        result = solve_xorshift128p(observed)

        if result:
            r_s0, r_s1 = result
            matches, total = verify_state(r_s0, r_s1, observed)
            print(f"\nVerification: {matches}/{total} bits match")

            if r_s0 == seed_s0 and r_s1 == seed_s1:
                print("EXACT MATCH with original seed!")
            elif matches == total:
                print("All bits match (equivalent solution, may differ in state)")

            # Predict future
            n_future = 20
            pred_all, _, _ = generate_sequence(r_s0, r_s1, n_bits + n_future)
            actual_all, _, _ = generate_sequence(seed_s0, seed_s1, n_bits + n_future)
            future_pred = pred_all[n_bits:]
            future_actual = actual_all[n_bits:]
            future_match = sum(1 for a, b in zip(future_pred, future_actual) if a == b)
            print(f"Future prediction: {future_match}/{n_future} correct")
            print(f"  Predicted: {''.join(str(b) for b in future_pred)}")
            print(f"  Actual:    {''.join(str(b) for b in future_actual)}")

            if matches == total and future_match == n_future:
                print(f"\nSUCCESS -- {n_bits} bits is sufficient for full recovery!")
                return True
            elif matches == total:
                print(f"\nPARTIAL -- bits match but future prediction failed "
                      f"(multiple solutions exist for {n_bits} bits)")
        else:
            print(f"\nSolver failed with {n_bits} bits -- may need more observations")

    return False


def verify_tseitin_gates():
    """Verify that Tseitin gates produce correct truth tables."""
    # Test XOR gate
    for a_val in [0, 1]:
        for b_val in [0, 1]:
            enc = CNFEncoder()
            enc.next_var = 1
            enc.clauses = []
            va = enc.new_var()  # var 1
            vb = enc.new_var()  # var 2
            if a_val:
                enc.clauses.append([va])
            else:
                enc.clauses.append([-va])
            if b_val:
                enc.clauses.append([vb])
            else:
                enc.clauses.append([-vb])
            vc = enc.gate_xor2(va, vb)
            expected = a_val ^ b_val

            solver = Cadical195()
            for cl in enc.clauses:
                solver.add_clause(cl)
            assert solver.solve(), f"XOR gate UNSAT for a={a_val}, b={b_val}"
            model = set(solver.get_model())
            got = 1 if vc in model else 0
            solver.delete()
            if got != expected:
                print(f"  XOR FAIL: {a_val} ^ {b_val} = {got}, expected {expected}")
                return False

    # Test AND gate
    for a_val in [0, 1]:
        for b_val in [0, 1]:
            enc = CNFEncoder()
            enc.next_var = 1
            enc.clauses = []
            va = enc.new_var()
            vb = enc.new_var()
            if a_val:
                enc.clauses.append([va])
            else:
                enc.clauses.append([-va])
            if b_val:
                enc.clauses.append([vb])
            else:
                enc.clauses.append([-vb])
            vc = enc.gate_and(va, vb)
            expected = a_val & b_val

            solver = Cadical195()
            for cl in enc.clauses:
                solver.add_clause(cl)
            assert solver.solve()
            model = set(solver.get_model())
            got = 1 if vc in model else 0
            solver.delete()
            if got != expected:
                print(f"  AND FAIL: {a_val} & {b_val} = {got}, expected {expected}")
                return False

    # Test MAJ gate
    for a_val in [0, 1]:
        for b_val in [0, 1]:
            for c_val in [0, 1]:
                enc = CNFEncoder()
                enc.next_var = 1
                enc.clauses = []
                va = enc.new_var()
                vb = enc.new_var()
                vcc = enc.new_var()
                for (v, val) in [(va, a_val), (vb, b_val), (vcc, c_val)]:
                    enc.clauses.append([v] if val else [-v])
                vd = enc.gate_maj(va, vb, vcc)
                expected = 1 if (a_val + b_val + c_val) >= 2 else 0

                solver = Cadical195()
                for cl in enc.clauses:
                    solver.add_clause(cl)
                assert solver.solve()
                model = set(solver.get_model())
                got = 1 if vd in model else 0
                solver.delete()
                if got != expected:
                    print(f"  MAJ FAIL: MAJ({a_val},{b_val},{c_val}) = {got}, "
                          f"expected {expected}")
                    return False

    print("  All gate truth tables verified (XOR, AND, MAJ).")
    return True


# ============================================================================
# 8. Data Loader
# ============================================================================

def load_chronological_bits():
    """Load observed bits from chronological_trades.json."""
    data_file = os.path.join(os.path.dirname(__file__), '..', 'analysis',
                             'chronological_trades.json')
    if not os.path.exists(data_file):
        print(f"Data file not found: {data_file}")
        print("Run: node tools/extractChronologicalTrades.js first")
        return None

    with open(data_file) as f:
        data = json.load(f)

    trades = data['trades']
    print(f"Loaded {len(trades)} chronological trades")

    bits = [t['bit'] for t in trades]
    return bits, trades


def find_single_token_windows(trades, min_length=30):
    """Find windows where only one token is active (consecutive PRNG outputs)."""
    sessions = {}
    for t in trades:
        mint = t['mint']
        if mint not in sessions:
            sessions[mint] = {'first': t['slot'], 'last': t['slot'], 'n': 0}
        s = sessions[mint]
        s['last'] = max(s['last'], t['slot'])
        s['n'] += 1

    windows = []
    cur = None
    for t in trades:
        active = sum(1 for s in sessions.values()
                     if t['slot'] >= s['first'] and t['slot'] <= s['last'])
        if active == 1:
            if cur is None or t['mint'] != cur['mint']:
                if cur and len(cur['bits']) >= min_length:
                    windows.append(cur)
                cur = {'mint': t['mint'], 'bits': [], 'trades': []}
            cur['bits'].append(t['bit'])
            cur['trades'].append(t)
        else:
            if cur and len(cur['bits']) >= min_length:
                windows.append(cur)
            cur = None

    if cur and len(cur['bits']) >= min_length:
        windows.append(cur)

    return windows


# ============================================================================
# 9. Main
# ============================================================================

if __name__ == '__main__':
    args = sys.argv[1:]

    if '--test' in args:
        success = self_test()
        sys.exit(0 if success else 1)

    elif any(a.startswith('--bits=') for a in args):
        # Direct bit string
        bit_str = [a for a in args if a.startswith('--bits=')][0].split('=', 1)[1]
        bits = [int(b) for b in bit_str if b in '01']
        if len(bits) == 0:
            print("Error: no valid bits in --bits argument")
            sys.exit(1)

        result = solve_xorshift128p(bits)
        if result:
            s0, s1 = result
            matches, total = verify_state(s0, s1, bits)
            print(f"\nVerification: {matches}/{total} bits match")

            # Predict next 50
            n_future = 50
            pred, _, _ = generate_sequence(s0, s1, len(bits) + n_future)
            future = pred[len(bits):]
            print(f"\nPredicted next {n_future}:")
            print(f"  Bits:    {''.join(str(b) for b in future)}")
            print(f"  Actions: {''.join('B' if b == 0 else 'S' for b in future)}")

    else:
        # Load from chronological trades
        result = load_chronological_bits()
        if result is None:
            sys.exit(1)

        bits, trades = result

        print(f"\n{'='*65}")
        print(f" Strategy 1: Full interleaved sequence")
        print(f"{'='*65}\n")
        print(f"Attempting solve on first {min(300, len(bits))} bits...")
        print("(Assumes ALL trades are consecutive PRNG outputs)")

        chunk = bits[:min(300, len(bits))]
        sol = solve_xorshift128p(chunk)

        if sol:
            s0, s1 = sol
            all_pred, _, _ = generate_sequence(s0, s1, len(bits))
            matches = sum(1 for a, b in zip(all_pred, bits) if a == b)
            pct = matches / len(bits) * 100
            print(f"\nVerification against all {len(bits)} bits: "
                  f"{matches}/{len(bits)} match ({pct:.1f}%)")
            if pct > 99:
                print("EXCELLENT -- seed recovered!")
            elif pct > 55:
                print("Partial match -- some interleaving may be present.")
            else:
                print("Poor match -- not consecutive PRNG outputs.")

        print(f"\n{'='*65}")
        print(f" Strategy 2: Single-token windows")
        print(f"{'='*65}\n")

        windows = find_single_token_windows(trades, min_length=20)
        print(f"Found {len(windows)} single-token windows (>= 20 trades)\n")

        for i, w in enumerate(windows[:5]):
            print(f"Window {i+1}: {w['mint'][:16]}... -- {len(w['bits'])} trades")
            print(f"  Bits: {''.join(str(b) for b in w['bits'][:60])}")

            if len(w['bits']) >= 30:
                print(f"  Attempting solve on {len(w['bits'])} bits...")
                sol = solve_xorshift128p(w['bits'])
                if sol:
                    s0, s1 = sol
                    matches, total = verify_state(s0, s1, w['bits'])
                    print(f"  Verification: {matches}/{total}")
