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
///   SCHEMA_UID (optional)
///   PLATFORM_ADDRESS (optional)
contract Deploy is Script {
    // Base Sepolia defaults
    address internal constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address internal constant BASE_SEPOLIA_EAS = 0x4200000000000000000000000000000000000021;

    function run() external returns (MemonexMarket market) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        address usdc = vm.envOr("USDC_ADDRESS", BASE_SEPOLIA_USDC);
        address eas = vm.envOr("EAS_ADDRESS", BASE_SEPOLIA_EAS);
        bytes32 schema = vm.envOr("SCHEMA_UID", bytes32(0));
        address platform = vm.envOr("PLATFORM_ADDRESS", deployer);

        vm.startBroadcast(pk);
        market = new MemonexMarket(usdc, eas, schema, platform);
        vm.stopBroadcast();
    }
}
