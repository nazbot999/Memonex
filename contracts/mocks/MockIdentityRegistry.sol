// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import {IIdentityRegistry} from "../interfaces/IIdentityRegistry.sol";

/// @dev Simple ERC-721 mock identity registry for tests.
contract MockIdentityRegistry is ERC721, IIdentityRegistry {
    uint256 private _nextAgentId = 1;
    mapping(address => uint256) private _agentIds;

    bool public shouldRevertRegister;
    bool public shouldRevertAgentIdOf;
    bool public shouldRevertOwnerOf;

    event Registered(address indexed owner, uint256 indexed agentId, string agentURI);

    constructor() ERC721("Mock Agent", "AGENT") {}

    function setRevertRegister(bool shouldRevert) external {
        shouldRevertRegister = shouldRevert;
    }

    function setRevertAgentIdOf(bool shouldRevert) external {
        shouldRevertAgentIdOf = shouldRevert;
    }

    function setRevertOwnerOf(bool shouldRevert) external {
        shouldRevertOwnerOf = shouldRevert;
    }

    function register(string calldata agentURI) external returns (uint256 agentId) {
        if (shouldRevertRegister) revert("register revert");

        agentId = _agentIds[msg.sender];
        if (agentId == 0) {
            agentId = _nextAgentId++;
            _agentIds[msg.sender] = agentId;
            _mint(msg.sender, agentId);
        }

        emit Registered(msg.sender, agentId, agentURI);
    }

    function agentIdOf(address owner) external view returns (uint256) {
        if (shouldRevertAgentIdOf) revert("agentIdOf revert");
        return _agentIds[owner];
    }

    function ownerOf(uint256 agentId) public view override(ERC721, IIdentityRegistry) returns (address) {
        if (shouldRevertOwnerOf) revert("ownerOf revert");
        return ERC721.ownerOf(agentId);
    }

    /// @dev OZ v5 uses _update instead of _afterTokenTransfer
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = super._update(to, tokenId, auth);
        if (from != address(0)) {
            _agentIds[from] = 0;
        }
        if (to != address(0)) {
            _agentIds[to] = tokenId;
        }
        return from;
    }
}
