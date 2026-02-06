// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-8004 Reputation Registry interface.
interface IReputationRegistry {
    /// @notice Submit feedback about an agent for a given task.
    function submitFeedback(
        uint256 targetAgentId,
        uint256 taskId,
        int8 score,
        string calldata comment
    ) external;
}
