"""Independently verify the frozen HTTP authentication vector."""

import hashlib
import json
import re
from pathlib import Path


MASK64 = (1 << 64) - 1
KECCAK_RATE = 136
KECCAK_ROTATIONS = (
    (0, 36, 3, 41, 18),
    (1, 44, 10, 45, 2),
    (62, 6, 43, 15, 61),
    (28, 55, 25, 21, 56),
    (27, 20, 39, 8, 14),
)
KECCAK_ROUND_CONSTANTS = (
    0x0000000000000001,
    0x0000000000008082,
    0x800000000000808A,
    0x8000000080008000,
    0x000000000000808B,
    0x0000000080000001,
    0x8000000080008081,
    0x8000000000008009,
    0x000000000000008A,
    0x0000000000000088,
    0x0000000080008009,
    0x000000008000000A,
    0x000000008000808B,
    0x800000000000008B,
    0x8000000000008089,
    0x8000000000008003,
    0x8000000000008002,
    0x8000000000000080,
    0x000000000000800A,
    0x800000008000000A,
    0x8000000080008081,
    0x8000000000008080,
    0x0000000080000001,
    0x8000000080008008,
)

FIELD_PRIME = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
CURVE_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
HALF_ORDER = CURVE_ORDER // 2
GENERATOR = (
    0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)
POINT = tuple[int, int] | None


def rotate_left(value: int, amount: int) -> int:
    if amount == 0:
        return value & MASK64
    return ((value << amount) | (value >> (64 - amount))) & MASK64


def keccak_f(state: list[int]) -> None:
    for round_constant in KECCAK_ROUND_CONSTANTS:
        column_parity = [
            state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]
            for x in range(5)
        ]
        column_delta = [
            column_parity[(x - 1) % 5] ^ rotate_left(column_parity[(x + 1) % 5], 1)
            for x in range(5)
        ]
        for x in range(5):
            for y in range(5):
                state[x + 5 * y] ^= column_delta[x]

        rotated = [0] * 25
        for x in range(5):
            for y in range(5):
                destination_x = y
                destination_y = (2 * x + 3 * y) % 5
                rotated[destination_x + 5 * destination_y] = rotate_left(
                    state[x + 5 * y], KECCAK_ROTATIONS[x][y]
                )

        for x in range(5):
            for y in range(5):
                state[x + 5 * y] = (
                    rotated[x + 5 * y]
                    ^ ((~rotated[(x + 1) % 5 + 5 * y]) & rotated[(x + 2) % 5 + 5 * y])
                ) & MASK64

        state[0] ^= round_constant


def keccak256(value: bytes) -> bytes:
    padded = bytearray(value)
    padded.append(0x01)
    while len(padded) % KECCAK_RATE != KECCAK_RATE - 1:
        padded.append(0)
    padded.append(0x80)

    state = [0] * 25
    for offset in range(0, len(padded), KECCAK_RATE):
        block = padded[offset : offset + KECCAK_RATE]
        for index, byte in enumerate(block):
            state[index // 8] ^= byte << (8 * (index % 8))
        keccak_f(state)

    return b"".join(
        ((state[index] >> (8 * byte)) & 0xFF).to_bytes(1, "little")
        for index in range(4)
        for byte in range(8)
    )


def point_add(first: POINT, second: POINT) -> POINT:
    if first is None:
        return second
    if second is None:
        return first

    x1, y1 = first
    x2, y2 = second
    if x1 == x2 and (y1 + y2) % FIELD_PRIME == 0:
        return None

    if first == second:
        slope = (3 * x1 * x1) * pow(2 * y1, -1, FIELD_PRIME) % FIELD_PRIME
    else:
        slope = (y2 - y1) * pow(x2 - x1, -1, FIELD_PRIME) % FIELD_PRIME

    x3 = (slope * slope - x1 - x2) % FIELD_PRIME
    y3 = (slope * (x1 - x3) - y1) % FIELD_PRIME
    return x3, y3


def point_mul(scalar: int, point: POINT) -> POINT:
    result: POINT = None
    addend = point
    while scalar:
        if scalar & 1:
            result = point_add(result, addend)
        addend = point_add(addend, addend)
        scalar >>= 1
    return result


def parse_public_key(value: str) -> tuple[bytes, tuple[int, int]]:
    if not re.fullmatch(r"0x04[0-9a-f]{128}", value):
        raise ValueError("invalid public key encoding")
    encoded = bytes.fromhex(value[2:])
    point = int.from_bytes(encoded[1:33], "big"), int.from_bytes(encoded[33:], "big")
    x, y = point
    if x >= FIELD_PRIME or y >= FIELD_PRIME or (y * y - x * x * x - 7) % FIELD_PRIME:
        raise ValueError("public key is not on secp256k1")
    return encoded, point


def parse_signature(value: str) -> tuple[int, int, int, bytes]:
    if not re.fullmatch(r"0x[0-9a-f]{130}", value):
        raise ValueError("invalid signature encoding")
    encoded = bytes.fromhex(value[2:])
    recovery = encoded[64]
    r = int.from_bytes(encoded[:32], "big")
    s = int.from_bytes(encoded[32:64], "big")
    if recovery not in (27, 28):
        raise ValueError("unsupported recovery value")
    if not 0 < r < CURVE_ORDER or not 0 < s <= HALF_ORDER:
        raise ValueError("invalid or high-S signature")
    return r, s, recovery - 27, encoded


def recover_public_key(digest: bytes, r: int, s: int, recovery: int) -> tuple[int, int]:
    x = r + (recovery // 2) * CURVE_ORDER
    if x >= FIELD_PRIME:
        raise ValueError("recovery point is outside secp256k1")
    alpha = (pow(x, 3, FIELD_PRIME) + 7) % FIELD_PRIME
    y = pow(alpha, (FIELD_PRIME + 1) // 4, FIELD_PRIME)
    if (y * y) % FIELD_PRIME != alpha:
        raise ValueError("recovery point is not on secp256k1")
    if y & 1 != recovery & 1:
        y = FIELD_PRIME - y
    recovery_point = (x, y)
    if point_mul(CURVE_ORDER, recovery_point) is not None:
        raise ValueError("recovery point has the wrong subgroup")

    message_scalar = int.from_bytes(digest, "big")
    inverse = pow(r, -1, CURVE_ORDER)
    public_key = point_mul(
        inverse,
        point_add(
            point_mul(s, recovery_point),
            point_mul((-message_scalar) % CURVE_ORDER, GENERATOR),
        ),
    )
    if public_key is None:
        raise ValueError("recovered public key is infinity")
    return public_key


def encode_public_key(point: tuple[int, int]) -> bytes:
    return b"\x04" + point[0].to_bytes(32, "big") + point[1].to_bytes(32, "big")


def verify_signature(
    public_key: str, address: str, message: bytes, signature: str
) -> None:
    encoded_public_key, public_point = parse_public_key(public_key)
    if not re.fullmatch(r"0x[0-9a-f]{40}", address):
        raise ValueError("invalid address encoding")
    derived_address = "0x" + keccak256(encoded_public_key[1:])[-20:].hex()
    if derived_address != address:
        raise ValueError("public key does not derive the manifest address")

    r, s, recovery, _ = parse_signature(signature)
    prefix = b"\x19Ethereum Signed Message:\n" + str(len(message)).encode("ascii")
    digest = keccak256(prefix + message)
    recovered = recover_public_key(digest, r, s, recovery)
    if recovered != public_point or encode_public_key(recovered) != encoded_public_key:
        raise ValueError("signature recovery does not match the public key")

    inverse = pow(s, -1, CURVE_ORDER)
    u1 = int.from_bytes(digest, "big") * inverse % CURVE_ORDER
    u2 = r * inverse % CURVE_ORDER
    check = point_add(point_mul(u1, GENERATOR), point_mul(u2, public_point))
    if check is None or check[0] % CURVE_ORDER != r:
        raise ValueError("ECDSA signature equation failed")


def expect_failure(action) -> None:
    try:
        action()
    except ValueError:
        return
    raise AssertionError("invalid authentication value was accepted")


fixture_path = Path(__file__).parent.parent / "test" / "fixtures" / "v2-http-auth.json"
fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

body = fixture["body"].encode("utf-8")
digest = "sha256:" + hashlib.sha256(body).hexdigest()
assert digest == fixture["digest"]

components = [
    "Gossip request v2",
    "gossip/2-draft.1",
    "gossip-eip191-v2",
    fixture["audience"],
    fixture["endpoint"],
    fixture["method"],
    fixture["target"],
    digest,
    fixture["nonce"],
    fixture["expires"],
]
assert all("\n" not in component and "\r" not in component for component in components)
assert fixture["message"] == "\n".join(components)
assert len(body) <= 65_536
assert (
    keccak256(b"").hex()
    == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
)
assert (
    keccak256(b"abc").hex()
    == "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
)

verify_signature(
    fixture["public_key"],
    fixture["address"],
    fixture["message"].encode("utf-8"),
    fixture["signature"],
)

high_s = bytearray(bytes.fromhex(fixture["signature"][2:]))
original_s = int.from_bytes(high_s[32:64], "big")
high_s[32:64] = (CURVE_ORDER - original_s).to_bytes(32, "big")
expect_failure(lambda: parse_signature("0x" + high_s.hex()))

wrong_recovery = bytearray(bytes.fromhex(fixture["signature"][2:]))
wrong_recovery[64] = 26
expect_failure(lambda: parse_signature("0x" + wrong_recovery.hex()))

print(
    "v2 HTTP authentication digest, EIP-191 signature, and secp256k1 recovery verified"
)
