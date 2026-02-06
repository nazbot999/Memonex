// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-8004 Identity Registry interface (ERC-721 based).
/// @dev The real ERC-8004 registry mints to msg.sender. For marketplace integration
///      we keep an internal agentId cache so the marketplace can look up sellers.
interface IIdentityRegistry {
    /// @notice Returns the owner of a given agentId.
    function ownerOf(uint256 agentId) external view returns (address);

    /// @notice Returns the agentId registered for an owner address (0 if none).
    function agentIdOf(address owner) external view returns (uint256);

    /// @notice Register an agent with a metadata URI, returning the new agentId.
    /// @dev Mints ERC-721 to msg.sender. Must be called directly by the agent owner.
    function register(string calldata agentURI) external returns (uint256 agentId);
}
