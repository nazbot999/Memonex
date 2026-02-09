// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ERC-8004 Identity Registry interface (spec-compliant).
/// @dev Based on the ERC-8004 standard. The registry is an ERC-721 where each
///      token represents a registered agent identity. There is no `agentIdOf`
///      reverse lookup in the spec — callers must track their own agentId.
interface IIdentityRegistry {
    struct MetadataEntry {
        string key;
        bytes value;
    }

    // --- Events ---
    event Registered(uint256 indexed agentId, address indexed owner, string agentURI);
    event URIUpdated(uint256 indexed agentId, string newURI);
    event MetadataSet(uint256 indexed agentId, string key);

    // --- Registration ---

    /// @notice Register an agent with no metadata (mints ERC-721 to msg.sender).
    function register() external returns (uint256 agentId);

    /// @notice Register an agent with a URI.
    function register(string calldata agentURI) external returns (uint256 agentId);

    /// @notice Register an agent with a URI and initial metadata.
    function register(string calldata agentURI, MetadataEntry[] calldata metadata) external returns (uint256 agentId);

    // --- ERC-721 ---

    /// @notice Returns the owner of a given agentId.
    function ownerOf(uint256 agentId) external view returns (address);

    // --- URI / Metadata ---

    /// @notice Set the agent URI for a registered agent.
    function setAgentURI(uint256 agentId, string calldata newURI) external;

    /// @notice Get a metadata value by key.
    function getMetadata(uint256 agentId, string calldata key) external view returns (bytes memory);

    /// @notice Set a metadata key/value pair.
    function setMetadata(uint256 agentId, string calldata key, bytes calldata value) external;

    // --- Wallet ---

    /// @notice Get the associated wallet address for an agent.
    function getAgentWallet(uint256 agentId) external view returns (address);

    /// @notice Set the associated wallet address for an agent.
    function setAgentWallet(uint256 agentId, address wallet) external;

    /// @notice Unset the associated wallet address for an agent.
    function unsetAgentWallet(uint256 agentId) external;
}
