#!/usr/bin/env python3
"""
crackPrngSeed.py — Recover xorshift128+ internal state from 1-bit observations.

V8's Math.random() uses xorshift128+ with 128 bits of state (s0, s1).
Each call produces a double in [0, 1) from which we observe only
whether the result is < 0.5 (buy=0) or >= 0.5 (sell=1).

The solver uses Z3 SMT solver to find (s0, s1) consistent with all
observed bits. Once found, we can predict ALL future Math.random() outputs.

Usage:
    python3 tools/crackPrngSeed.py                          # from chronological_trades.json
    python3 tools/crackPrngSeed.py --bits=01001101...        # direct bit string
    python3 tools/crackPrngSeed.py --test                    # self-test with known seed
    python3 tools/crackPrngSeed.py --verify=N                # verify N predictions after solve

V8 xorshift128+ algorithm (src/base/utils/random-number-generator.h):
    s1 = state0
    s0 = state1
    state0 = s0
    s1 ^= s1 << 23
    s1 ^= s1 >> 17
    s1 ^= s0
    s1 ^= s0 >> 26
    state1 = s1
    output = state0 + state1  (unsigned 64-bit addition)
    double = (output >> 12) * 2^-52  → value in [0, 1)

The MSB (bit 63) of `output` determines if result >= 0.5:
    if bit 63 of (state0 + state1) == 1 → double >= 0.5 → sell (1)
    if bit 63 of (state0 + state1) == 0 → double < 0.5  → buy (0)

This is a simplification — the actual mapping is via the top 52 bits forming
the mantissa of an IEEE 754 double. But the MSB check is correct for the
< 0.5 / >= 0.5 threshold.
"""

import json
import sys
import os
import time
from z3 import BitVec, BitVecVal, Solver, sat, LShR, Extract, If

# ═══════════════════════════════════════════════════════════════════════════
# V8 xorshift128+ model in Z3
# ═══════════════════════════════════════════════════════════════════════════

def xs128p_step(s0_sym, s1_sym):
    """
    One step of V8's xorshift128+.
    Returns (new_s0, new_s1, output).
    """
    # s1 = state0, s0 = state1
    s1 = s0_sym
    s0 = s1_sym

    # new state0 = s0
    new_s0 = s0

    # s1 ^= s1 << 23
    s1 = s1 ^ (s1 << 23)
    # s1 ^= s1 >> 17   (logical shift right)
    s1 = s1 ^ LShR(s1, 17)
    # s1 ^= s0
    s1 = s1 ^ s0
    # s1 ^= s0 >> 26   (logical shift right)
    s1 = s1 ^ LShR(s0, 26)

    new_s1 = s1

    # output = state0 + state1 (64-bit unsigned addition, wrapping)
    output = new_s0 + new_s1

    return new_s0, new_s1, output


def solve_xorshift128p(observed_bits, max_attempts=3, timeout_s=300):
    """
    Solve for xorshift128+ state given a sequence of 1-bit observations.

    observed_bits: list of 0/1 where 0 = Math.random() < 0.5, 1 = >= 0.5
    Returns: (state0, state1) or None
    """
    N = len(observed_bits)
    print(f"Solving xorshift128+ with {N} 1-bit observations...")
    print(f"Sequence: {''.join(str(b) for b in observed_bits[:50])}{'...' if N > 50 else ''}")

    # Symbolic initial state
    state0 = BitVec('state0', 64)
    state1 = BitVec('state1', 64)

    solver = Solver()
    solver.set("timeout", timeout_s * 1000)  # milliseconds

    s0 = state0
    s1 = state1

    for i in range(N):
        s0, s1, output = xs128p_step(s0, s1)

        # MSB of output determines the bit
        # bit 63 of output: Extract(63, 63, output)
        msb = Extract(63, 63, output)

        if observed_bits[i] == 1:
            # Math.random() >= 0.5 → MSB = 1
            solver.add(msb == BitVecVal(1, 1))
        else:
            # Math.random() < 0.5 → MSB = 0
            solver.add(msb == BitVecVal(0, 1))

    print(f"Constraints added. Solving (timeout={timeout_s}s)...")
    start_time = time.time()

    result = solver.check()
    elapsed = time.time() - start_time

    if result == sat:
        model = solver.model()
        s0_val = model[state0].as_long()
        s1_val = model[state1].as_long()
        print(f"SOLVED in {elapsed:.1f}s!")
        print(f"  state0 = 0x{s0_val:016x}")
        print(f"  state1 = 0x{s1_val:016x}")
        return s0_val, s1_val
    else:
        print(f"Failed ({result}) after {elapsed:.1f}s")
        return None


# ═══════════════════════════════════════════════════════════════════════════
# Native Python xorshift128+ for verification
# ═══════════════════════════════════════════════════════════════════════════

MASK64 = (1 << 64) - 1

def xs128p_native_step(s0, s1):
    """Native Python implementation of V8's xorshift128+ step."""
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
    # V8: (output >> 12) * 2^-52
    return (output >> 12) * (2 ** -52)


def output_to_bit(output):
    """Convert output to the observed bit (0 if < 0.5, 1 if >= 0.5)."""
    return 1 if output_to_double(output) >= 0.5 else 0


def generate_sequence(s0, s1, n):
    """Generate n bits from the given state."""
    bits = []
    for _ in range(n):
        s0, s1, output = xs128p_native_step(s0, s1)
        bits.append(output_to_bit(output))
    return bits, s0, s1


def verify_state(s0, s1, observed_bits):
    """Verify that the recovered state produces the observed sequence."""
    predicted, _, _ = generate_sequence(s0, s1, len(observed_bits))
    matches = sum(1 for a, b in zip(predicted, observed_bits) if a == b)
    return matches, len(observed_bits)


# ═══════════════════════════════════════════════════════════════════════════
# Self-test
# ═══════════════════════════════════════════════════════════════════════════

def self_test():
    """Test solver with a known seed."""
    import random

    print("═══════════════════════════════════════════════════════════════")
    print(" SELF-TEST: Crack known xorshift128+ seed")
    print("═══════════════════════════════════════════════════════════════\n")

    # Generate a random seed
    seed_s0 = random.getrandbits(64)
    seed_s1 = random.getrandbits(64)
    if seed_s1 == 0:
        seed_s1 = 1  # state1 can't be 0

    print(f"Known seed: s0=0x{seed_s0:016x}, s1=0x{seed_s1:016x}\n")

    # Generate observed bits
    for n_bits in [64, 128, 256, 512]:
        print(f"\n--- Testing with {n_bits} bits ---")
        observed, _, _ = generate_sequence(seed_s0, seed_s1, n_bits)
        result = solve_xorshift128p(observed, timeout_s=60)

        if result:
            r_s0, r_s1 = result
            # Verify
            matches, total = verify_state(r_s0, r_s1, observed)
            print(f"  Verification: {matches}/{total} bits match")
            if r_s0 == seed_s0 and r_s1 == seed_s1:
                print(f"  EXACT MATCH with original seed!")
            elif matches == total:
                print(f"  All bits match but different state (equivalent solution)")

            # Predict next 20 bits
            pred, _, _ = generate_sequence(r_s0, r_s1, n_bits + 20)
            actual, _, _ = generate_sequence(seed_s0, seed_s1, n_bits + 20)
            future_pred = pred[n_bits:]
            future_actual = actual[n_bits:]
            future_match = sum(1 for a, b in zip(future_pred, future_actual) if a == b)
            print(f"  Future prediction: {future_match}/20 correct")
            print(f"    Predicted: {''.join(str(b) for b in future_pred)}")
            print(f"    Actual:    {''.join(str(b) for b in future_actual)}")

            if matches == total and future_match == 20:
                print(f"\n  SUCCESS — {n_bits} bits is sufficient for recovery!")
                return True
        else:
            print(f"  Solver failed with {n_bits} bits")

    return False


# ═══════════════════════════════════════════════════════════════════════════
# Load data from chronological trades
# ═══════════════════════════════════════════════════════════════════════════

def load_chronological_bits():
    """Load bits from the chronological trades extraction."""
    data_file = os.path.join(os.path.dirname(__file__), '..', 'analysis', 'chronological_trades.json')
    if not os.path.exists(data_file):
        print(f"Data file not found: {data_file}")
        print("Run: node tools/extractChronologicalTrades.js first")
        return None

    with open(data_file) as f:
        data = json.load(f)

    trades = data['trades']
    print(f"Loaded {len(trades)} chronological trades")

    # The full sequence of bits (interleaved across tokens)
    bits = [t['bit'] for t in trades]
    return bits, trades


def find_single_token_windows(trades, min_length=30):
    """
    Find windows where only one token is active.
    These give us consecutive PRNG outputs.
    """
    # Build token sessions
    sessions = {}
    for t in trades:
        mint = t['mint']
        if mint not in sessions:
            sessions[mint] = {'first': t['slot'], 'last': t['slot'], 'n': 0}
        s = sessions[mint]
        s['last'] = max(s['last'], t['slot'])
        s['n'] += 1

    # Find non-overlapping windows
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


# ═══════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    args = sys.argv[1:]

    if '--test' in args:
        success = self_test()
        sys.exit(0 if success else 1)

    elif '--bits=' in ' '.join(args):
        # Direct bit string
        bit_str = [a for a in args if a.startswith('--bits=')][0].split('=')[1]
        bits = [int(b) for b in bit_str]
        result = solve_xorshift128p(bits)
        if result:
            s0, s1 = result
            # Predict next 50
            pred, _, _ = generate_sequence(s0, s1, len(bits) + 50)
            future = pred[len(bits):]
            print(f"\nPredicted next 50: {''.join(str(b) for b in future)}")
            print(f"As actions: {''.join('B' if b==0 else 'S' for b in future)}")

    else:
        # Load from chronological trades
        result = load_chronological_bits()
        if result is None:
            sys.exit(1)

        bits, trades = result

        print(f"\n═══════════════════════════════════════════════════════════════")
        print(f" STRATEGY 1: Full interleaved sequence")
        print(f"═══════════════════════════════════════════════════════════════\n")
        print(f"Attempting solve on first {min(300, len(bits))} bits of full sequence...")
        print("(This assumes ALL trades are consecutive PRNG outputs — only true if")
        print("the bot processes tokens sequentially with a single PRNG stream)\n")

        chunk = bits[:min(300, len(bits))]
        result = solve_xorshift128p(chunk, timeout_s=120)

        if result:
            s0, s1 = result
            # Verify against remaining bits
            all_pred, _, _ = generate_sequence(s0, s1, len(bits))
            matches = sum(1 for a, b in zip(all_pred, bits) if a == b)
            print(f"\nVerification against all {len(bits)} bits: {matches}/{len(bits)} match ({matches/len(bits)*100:.1f}%)")
            if matches / len(bits) > 0.99:
                print("EXCELLENT — seed recovered! Full sequence is consecutive PRNG outputs.")
            elif matches / len(bits) > 0.5:
                print("Partial match — some outputs may be interleaved or from a different PRNG.")
            else:
                print("Poor match — the full sequence is NOT consecutive PRNG outputs.")

        print(f"\n═══════════════════════════════════════════════════════════════")
        print(f" STRATEGY 2: Single-token windows")
        print(f"═══════════════════════════════════════════════════════════════\n")

        windows = find_single_token_windows(trades, min_length=20)
        print(f"Found {len(windows)} single-token windows with >= 20 trades\n")

        for i, w in enumerate(windows[:5]):
            print(f"Window {i+1}: {w['mint'][:12]} — {len(w['bits'])} trades")
            print(f"  Bits: {''.join(str(b) for b in w['bits'][:50])}")

            if len(w['bits']) >= 40:
                print(f"  Attempting solve on {len(w['bits'])} bits...")
                result = solve_xorshift128p(w['bits'], timeout_s=120)
                if result:
                    s0, s1 = result
                    matches, total = verify_state(s0, s1, w['bits'])
                    print(f"  Verification: {matches}/{total}")
