// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IReputationRegistry} from "../interfaces/IReputationRegistry.sol";

/// @dev Mock reputation registry for tests. Spec-compliant interface.
contract MockReputationRegistry is IReputationRegistry {
    struct FeedbackEntry {
        address client;
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        string endpoint;
        string feedbackURI;
        bytes32 feedbackHash;
        bool revoked;
        uint256 timestamp;
    }

    // agentId => client => feedback entries
    mapping(uint256 => mapping(address => FeedbackEntry[])) private _feedbacks;
    mapping(uint256 => address[]) private _clients;
    mapping(uint256 => mapping(address => bool)) private _isClient;

    // Flat array for test assertions
    FeedbackEntry[] public feedbacksFlat;

    bool public shouldRevert;

    function setShouldRevert(bool should) external {
        shouldRevert = should;
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        if (shouldRevert) revert("giveFeedback revert");

        FeedbackEntry memory entry = FeedbackEntry({
            client: msg.sender,
            value: value,
            valueDecimals: valueDecimals,
            tag1: tag1,
            tag2: tag2,
            endpoint: endpoint,
            feedbackURI: feedbackURI,
            feedbackHash: feedbackHash,
            revoked: false,
            timestamp: block.timestamp
        });

        uint256 index = _feedbacks[agentId][msg.sender].length;
        _feedbacks[agentId][msg.sender].push(entry);
        feedbacksFlat.push(entry);

        if (!_isClient[agentId][msg.sender]) {
            _isClient[agentId][msg.sender] = true;
            _clients[agentId].push(msg.sender);
        }

        emit NewFeedback(agentId, msg.sender, index, value, tag1, tag2);
    }

    function revokeFeedback(uint256 agentId, uint256 feedbackIndex) external {
        FeedbackEntry storage entry = _feedbacks[agentId][msg.sender][feedbackIndex];
        entry.revoked = true;
        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    function appendResponse(uint256, uint256, string calldata) external pure {
        // no-op in mock
    }

    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint256 count, int256 summaryValue, uint8 summaryValueDecimals) {
        address[] memory clients_;
        if (clientAddresses.length > 0) {
            clients_ = new address[](clientAddresses.length);
            for (uint256 j = 0; j < clientAddresses.length; j++) {
                clients_[j] = clientAddresses[j];
            }
        } else {
            clients_ = _clients[agentId];
        }
        bool filterTag1 = bytes(tag1).length > 0;
        bool filterTag2 = bytes(tag2).length > 0;

        for (uint256 c = 0; c < clients_.length; c++) {
            FeedbackEntry[] storage entries = _feedbacks[agentId][clients_[c]];
            for (uint256 i = 0; i < entries.length; i++) {
                FeedbackEntry storage e = entries[i];
                if (e.revoked) continue;
                if (filterTag1 && keccak256(bytes(e.tag1)) != keccak256(bytes(tag1))) continue;
                if (filterTag2 && keccak256(bytes(e.tag2)) != keccak256(bytes(tag2))) continue;
                count++;
                summaryValue += int256(e.value);
            }
        }
    }

    function readFeedback(uint256 agentId, address client, uint256 feedbackIndex)
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
        )
    {
        FeedbackEntry storage e = _feedbacks[agentId][client][feedbackIndex];
        return (e.value, e.valueDecimals, e.tag1, e.tag2, e.endpoint, e.feedbackURI, e.feedbackHash, e.revoked, e.timestamp);
    }

    function getClients(uint256 agentId) external view returns (address[] memory) {
        return _clients[agentId];
    }

    function getLastIndex(uint256 agentId, address client) external view returns (uint256) {
        return _feedbacks[agentId][client].length;
    }

    function getIdentityRegistry() external pure returns (address) {
        return address(0);
    }

    // --- Test helpers ---

    function feedbackCount() external view returns (uint256) {
        return feedbacksFlat.length;
    }
}
