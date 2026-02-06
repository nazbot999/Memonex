// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import {MemonexMarket} from "../contracts/MemonexMarket.sol";

/// @notice Foundry deploy script
/// @dev Usage:
///   forge script script/Deploy.s.sol:Deploy --rpc-url $RPC_URL --broadcast --verify
/// Env:
///   PRIVATE_KEY (required)
///   USDC_ADDRESS (optional)
///   EAS_ADDRESS (optional)
///   COMPLETION_SCHEMA_UID (optional)
///   RATING_SCHEMA_UID (optional)
///   PLATFORM_ADDRESS (optional)
///   PLATFORM_FEE_BPS (optional)
///   RESERVE_WINDOW (optional)
///   IDENTITY_REGISTRY (optional)
///   REPUTATION_REGISTRY (optional)
///   VALIDATION_REGISTRY (optional)
contract Deploy is Script {
    // Base Sepolia defaults
    address internal constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address internal constant BASE_SEPOLIA_EAS = 0x4200000000000000000000000000000000000021;

    function run() external returns (MemonexMarket market) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        address usdc = vm.envOr("USDC_ADDRESS", BASE_SEPOLIA_USDC);
        address eas = vm.envOr("EAS_ADDRESS", BASE_SEPOLIA_EAS);
        bytes32 completionSchema = vm.envOr("COMPLETION_SCHEMA_UID", bytes32(0));
        bytes32 ratingSchema = vm.envOr("RATING_SCHEMA_UID", bytes32(0));
        address platform = vm.envOr("PLATFORM_ADDRESS", deployer);
        uint16 platformFeeBps = uint16(vm.envOr("PLATFORM_FEE_BPS", uint256(200)));
        uint32 reserveWindow = uint32(vm.envOr("RESERVE_WINDOW", uint256(2 hours)));
        address identityRegistry = vm.envOr("IDENTITY_REGISTRY", address(0));
        address reputationRegistry = vm.envOr("REPUTATION_REGISTRY", address(0));
        address validationRegistry = vm.envOr("VALIDATION_REGISTRY", address(0));

        vm.startBroadcast(pk);
        market = new MemonexMarket(
            usdc,
            eas,
            completionSchema,
            ratingSchema,
            platform,
            platformFeeBps,
            reserveWindow,
            identityRegistry,
            reputationRegistry,
            validationRegistry
        );
        vm.stopBroadcast();
    }
}
