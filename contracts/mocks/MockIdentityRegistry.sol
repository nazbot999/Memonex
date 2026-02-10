// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import {IIdentityRegistry} from "../interfaces/IIdentityRegistry.sol";

/// @dev ERC-721 mock identity registry for tests. Spec-compliant interface.
contract MockIdentityRegistry is ERC721, IIdentityRegistry {
    uint256 private _nextAgentId = 1;
    mapping(address => uint256) private _agentIds; // test-only reverse lookup
    mapping(uint256 => string) private _agentURIs;
    mapping(uint256 => mapping(string => bytes)) private _metadata;
    mapping(uint256 => address) private _agentWallets;

    bool public shouldRevertRegister;
    bool public shouldRevertOwnerOf;

    constructor() ERC721("Mock Agent", "AGENT") {}

    function setRevertRegister(bool shouldRevert) external {
        shouldRevertRegister = shouldRevert;
    }

    function setRevertOwnerOf(bool shouldRevert) external {
        shouldRevertOwnerOf = shouldRevert;
    }

    // --- Registration overloads ---

    function register() external returns (uint256 agentId) {
        return _doRegister(msg.sender, "", new IIdentityRegistry.MetadataEntry[](0));
    }

    function register(string calldata agentURI) external returns (uint256 agentId) {
        return _doRegister(msg.sender, agentURI, new IIdentityRegistry.MetadataEntry[](0));
    }

    function register(string calldata agentURI, MetadataEntry[] calldata metadata)
        external
        returns (uint256 agentId)
    {
        return _doRegister(msg.sender, agentURI, metadata);
    }

    function _doRegister(address owner, string memory agentURI, MetadataEntry[] memory metadata)
        internal
        returns (uint256 agentId)
    {
        if (shouldRevertRegister) revert("register revert");

        agentId = _agentIds[owner];
        if (agentId == 0) {
            agentId = _nextAgentId++;
            _agentIds[owner] = agentId;
            _safeMint(owner, agentId);
        }

        if (bytes(agentURI).length > 0) {
            _agentURIs[agentId] = agentURI;
        }

        for (uint256 i = 0; i < metadata.length; i++) {
            _metadata[agentId][metadata[i].key] = metadata[i].value;
        }

        emit Registered(agentId, owner, agentURI);
    }

    // --- ERC-721 ---

    function ownerOf(uint256 agentId) public view override(ERC721, IIdentityRegistry) returns (address) {
        if (shouldRevertOwnerOf) revert("ownerOf revert");
        return ERC721.ownerOf(agentId);
    }

    // --- URI / Metadata ---

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        _agentURIs[agentId] = newURI;
        emit URIUpdated(agentId, newURI);
    }

    function getMetadata(uint256 agentId, string calldata key) external view returns (bytes memory) {
        return _metadata[agentId][key];
    }

    function setMetadata(uint256 agentId, string calldata key, bytes calldata value) external {
        _metadata[agentId][key] = value;
        emit MetadataSet(agentId, key);
    }

    // --- Wallet ---

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return _agentWallets[agentId];
    }

    function setAgentWallet(uint256 agentId, address wallet) external {
        _agentWallets[agentId] = wallet;
    }

    function unsetAgentWallet(uint256 agentId) external {
        delete _agentWallets[agentId];
    }

    // --- Test helpers ---

    /// @dev Test-only reverse lookup (not in spec).
    function agentIdOf(address owner) external view returns (uint256) {
        return _agentIds[owner];
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
