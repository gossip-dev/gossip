// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

contract Mock1271 {
    bytes4 internal constant MAGICVALUE = 0x1626ba7e;
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 65) return bytes4(0xffffffff);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        return ecrecover(hash, v, r, s) == owner ? MAGICVALUE : bytes4(0xffffffff);
    }
}
