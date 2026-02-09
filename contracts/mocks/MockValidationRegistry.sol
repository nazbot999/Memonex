// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IValidationRegistry} from "../interfaces/IValidationRegistry.sol";

/// @dev Mock validation registry for tests. Spec-compliant request/response model.
contract MockValidationRegistry is IValidationRegistry {
    struct ValidationEntry {
        address requestor;
        address validator;
        uint256 agentId;
        string requestURI;
        uint8 response;
        string responseURI;
        bytes32 responseHash;
        string tag;
        bool responded;
        uint256 requestedAt;
        uint256 respondedAt;
    }

    mapping(bytes32 => ValidationEntry) private _validations;
    mapping(uint256 => bytes32[]) private _agentValidations;
    mapping(address => bytes32[]) private _validatorRequests;

    // Flat counters for test assertions
    uint256 private _totalValidations;

    bool public shouldRevert;

    function setShouldRevert(bool should) external {
        shouldRevert = should;
    }

    function validationRequest(
        address validator,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external {
        if (shouldRevert) revert("validationRequest revert");

        _validations[requestHash] = ValidationEntry({
            requestor: msg.sender,
            validator: validator,
            agentId: agentId,
            requestURI: requestURI,
            response: 0,
            responseURI: "",
            responseHash: bytes32(0),
            tag: "",
            responded: false,
            requestedAt: block.timestamp,
            respondedAt: 0
        });

        _agentValidations[agentId].push(requestHash);
        _validatorRequests[validator].push(requestHash);

        emit ValidationRequest(requestHash, validator, agentId, msg.sender);
    }

    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external {
        if (shouldRevert) revert("validationResponse revert");

        ValidationEntry storage entry = _validations[requestHash];
        entry.response = response;
        entry.responseURI = responseURI;
        entry.responseHash = responseHash;
        entry.tag = tag;
        entry.responded = true;
        entry.respondedAt = block.timestamp;
        _totalValidations++;

        emit ValidationResponse(requestHash, msg.sender, response, tag);
    }

    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (
            address requestor,
            address validator,
            uint256 agentId,
            uint8 response,
            string memory tag,
            bool responded,
            uint256 requestedAt,
            uint256 respondedAt
        )
    {
        ValidationEntry storage e = _validations[requestHash];
        return (e.requestor, e.validator, e.agentId, e.response, e.tag, e.responded, e.requestedAt, e.respondedAt);
    }

    function getSummary(
        uint256 agentId,
        address[] calldata validators,
        string calldata tag
    ) external view returns (uint256 count, uint256 averageResponse) {
        bytes32[] storage hashes = _agentValidations[agentId];
        bool filterValidators = validators.length > 0;
        bool filterTag = bytes(tag).length > 0;
        uint256 totalResponse = 0;

        for (uint256 i = 0; i < hashes.length; i++) {
            ValidationEntry storage e = _validations[hashes[i]];
            if (!e.responded) continue;
            if (filterTag && keccak256(bytes(e.tag)) != keccak256(bytes(tag))) continue;
            if (filterValidators) {
                bool found = false;
                for (uint256 v = 0; v < validators.length; v++) {
                    if (e.validator == validators[v]) { found = true; break; }
                }
                if (!found) continue;
            }
            count++;
            totalResponse += e.response;
        }

        if (count > 0) {
            averageResponse = totalResponse / count;
        }
    }

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return _agentValidations[agentId];
    }

    function getValidatorRequests(address validator) external view returns (bytes32[] memory) {
        return _validatorRequests[validator];
    }

    function getIdentityRegistry() external pure returns (address) {
        return address(0);
    }

    // --- Test helpers ---

    function validationCount() external view returns (uint256) {
        return _totalValidations;
    }
}
