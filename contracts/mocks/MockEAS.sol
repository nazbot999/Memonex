// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEAS} from "../interfaces/IEAS.sol";

/// @dev Minimal mock of EAS used for unit tests.
contract MockEAS is IEAS {
    event Attested(bytes32 indexed uid, bytes32 indexed schema, address indexed recipient, bytes data);

    AttestationRequest public lastRequest;

    function attest(AttestationRequest calldata request) external payable returns (bytes32 uid) {
        // very rough UID - enough for tests
        uid = keccak256(
            abi.encode(
                request.schema,
                request.data.recipient,
                request.data.expirationTime,
                request.data.revocable,
                request.data.refUID,
                request.data.data,
                request.data.value,
                msg.sender,
                block.number
            )
        );

        lastRequest = request;
        emit Attested(uid, request.schema, request.data.recipient, request.data.data);
    }
}
