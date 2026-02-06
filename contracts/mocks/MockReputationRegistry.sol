// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IReputationRegistry} from "../interfaces/IReputationRegistry.sol";

/// @dev Simple mock reputation registry for tests.
contract MockReputationRegistry is IReputationRegistry {
    struct Feedback {
        address submitter;
        uint256 targetAgentId;
        uint256 taskId;
        int8 score;
        string comment;
    }

    Feedback[] public feedbacks;
    bool public shouldRevert;

    event FeedbackSubmitted(
        address indexed submitter,
        uint256 indexed targetAgentId,
        uint256 indexed taskId,
        int8 score,
        string comment
    );

    function setShouldRevert(bool should) external {
        shouldRevert = should;
    }

    function submitFeedback(
        uint256 targetAgentId,
        uint256 taskId,
        int8 score,
        string calldata comment
    ) external {
        if (shouldRevert) revert("submitFeedback revert");
        feedbacks.push(
            Feedback({
                submitter: msg.sender,
                targetAgentId: targetAgentId,
                taskId: taskId,
                score: score,
                comment: comment
            })
        );
        emit FeedbackSubmitted(msg.sender, targetAgentId, taskId, score, comment);
    }

    function feedbackCount() external view returns (uint256) {
        return feedbacks.length;
    }
}
