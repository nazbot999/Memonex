// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IValidationRegistry} from "../interfaces/IValidationRegistry.sol";

/// @dev Simple mock validation registry for tests.
contract MockValidationRegistry is IValidationRegistry {
    struct Validation {
        address submitter;
        uint256 agentId;
        bytes32 taskHash;
        bool passed;
        string evidence;
    }

    Validation[] public validations;
    bool public shouldRevert;

    event ValidationRecorded(
        address indexed submitter,
        uint256 indexed agentId,
        bytes32 indexed taskHash,
        bool passed,
        string evidence
    );

    function setShouldRevert(bool should) external {
        shouldRevert = should;
    }

    function recordValidation(
        uint256 agentId,
        bytes32 taskHash,
        bool passed,
        string calldata evidence
    ) external {
        if (shouldRevert) revert("recordValidation revert");
        validations.push(
            Validation({
                submitter: msg.sender,
                agentId: agentId,
                taskHash: taskHash,
                passed: passed,
                evidence: evidence
            })
        );
        emit ValidationRecorded(msg.sender, agentId, taskHash, passed, evidence);
    }

    function validationCount() external view returns (uint256) {
        return validations.length;
    }
}
