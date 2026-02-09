// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ERC-8004 Reputation Registry interface (spec-compliant).
/// @dev Supports tagged feedback with aggregation via getSummary.
interface IReputationRegistry {
    // --- Events ---
    event NewFeedback(
        uint256 indexed agentId,
        address indexed client,
        uint256 indexed feedbackIndex,
        int128 value,
        string tag1,
        string tag2
    );
    event FeedbackRevoked(uint256 indexed agentId, address indexed client, uint256 indexed feedbackIndex);
    event ResponseAppended(uint256 indexed agentId, address indexed client, uint256 indexed feedbackIndex);

    // --- Core ---

    /// @notice Give feedback about an agent.
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;

    /// @notice Revoke previously given feedback.
    function revokeFeedback(uint256 agentId, uint256 feedbackIndex) external;

    /// @notice Append a response to existing feedback (by the agent being rated).
    function appendResponse(uint256 agentId, uint256 feedbackIndex, string calldata responseURI) external;

    // --- Views ---

    /// @notice Get aggregated reputation summary for an agent.
    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint256 count, int256 summaryValue, uint8 summaryValueDecimals);

    /// @notice Read a single feedback entry.
    function readFeedback(
        uint256 agentId,
        address client,
        uint256 feedbackIndex
    )
        external
        view
        returns (
            int128 value,
            uint8 valueDecimals,
            string memory tag1,
            string memory tag2,
            string memory endpoint,
            string memory feedbackURI,
            bytes32 feedbackHash,
            bool revoked,
            uint256 timestamp
        );

    /// @notice Get all client addresses that have given feedback for an agent.
    function getClients(uint256 agentId) external view returns (address[] memory);

    /// @notice Get the number of feedback entries from a client for an agent.
    function getLastIndex(uint256 agentId, address client) external view returns (uint256);

    /// @notice Get the identity registry used by this reputation registry.
    function getIdentityRegistry() external view returns (address);
}
