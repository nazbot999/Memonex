// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ERC-8004 Validation Registry interface (spec-compliant).
/// @dev Uses a request/response model. A requestor submits a validation request,
///      and a validator responds with a pass/fail result.
interface IValidationRegistry {
    // --- Events ---
    event ValidationRequest(
        bytes32 indexed requestHash,
        address indexed validator,
        uint256 indexed agentId,
        address requestor
    );
    event ValidationResponse(
        bytes32 indexed requestHash,
        address indexed validator,
        uint8 response,
        string tag
    );

    // --- Core ---

    /// @notice Submit a validation request.
    function validationRequest(
        address validator,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external;

    /// @notice Respond to a validation request.
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external;

    // --- Views ---

    /// @notice Get the status of a validation request.
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
        );

    /// @notice Get aggregated validation summary for an agent.
    function getSummary(
        uint256 agentId,
        address[] calldata validators,
        string calldata tag
    ) external view returns (uint256 count, uint256 averageResponse);

    /// @notice Get all validation request hashes for an agent.
    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory);

    /// @notice Get all validation request hashes for a validator.
    function getValidatorRequests(address validator) external view returns (bytes32[] memory);

    /// @notice Get the identity registry used by this validation registry.
    function getIdentityRegistry() external view returns (address);
}
