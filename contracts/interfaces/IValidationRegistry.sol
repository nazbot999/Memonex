// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-8004 Validation Registry interface.
interface IValidationRegistry {
    /// @notice Record a validation result for an agent/task.
    function recordValidation(
        uint256 agentId,
        bytes32 taskHash,
        bool passed,
        string calldata evidence
    ) external;
}
