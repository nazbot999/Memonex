// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal IEAS interface (subset) required for MemonexMarket.
/// @dev Mirrors the EAS attest request structs.
interface IEAS {
    struct AttestationRequest {
        bytes32 schema;
        AttestationRequestData data;
    }

    struct AttestationRequestData {
        address recipient;
        uint64 expirationTime;
        bool revocable;
        bytes32 refUID;
        bytes data;
        uint256 value;
    }

    /// @notice Creates a new attestation.
    /// @return uid The UID of the new attestation.
    function attest(AttestationRequest calldata request) external payable returns (bytes32 uid);
}
