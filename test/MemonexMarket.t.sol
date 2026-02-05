// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {MemonexMarket} from "../contracts/MemonexMarket.sol";
import {MockUSDC} from "../contracts/mocks/MockUSDC.sol";
import {MockEAS} from "../contracts/mocks/MockEAS.sol";

contract MemonexMarketTest is Test {
    MockUSDC usdc;
    MockEAS eas;
    MemonexMarket market;

    address seller = address(0xA11CE);
    address buyer = address(0xB0B);
    address other = address(0xCAFE);
    address platform = address(0xFEE);

    bytes32 schemaUID = keccak256("memonex.schema.v1");

    uint256 price = 10e6; // 10 USDC
    uint256 evalFee = 1e6; // 10% (within 1-20%)
    uint32 deliveryWindow = 6 hours;

    function setUp() public {
        usdc = new MockUSDC(6);
        eas = new MockEAS();

        market = new MemonexMarket(address(usdc), address(eas), schemaUID, platform);

        usdc.mint(buyer, 1_000e6);
        usdc.mint(other, 1_000e6);

        vm.label(seller, "seller");
        vm.label(buyer, "buyer");
        vm.label(other, "other");
        vm.label(platform, "platform");
        vm.label(address(market), "market");
        vm.label(address(usdc), "usdc");
        vm.label(address(eas), "eas");
    }

    function _listDefault() internal returns (uint256 listingId) {
        vm.prank(seller);
        listingId = market.listMemory(
            keccak256("content"),
            "ipfs://preview",
            "ipfs://encrypted",
            price,
            evalFee,
            deliveryWindow
        );
    }

    function _reserve(uint256 listingId, address who) internal {
        vm.startPrank(who);
        usdc.approve(address(market), evalFee);
        market.reserve(listingId, hex"010203");
        vm.stopPrank();
    }

    function _confirm(uint256 listingId, address who) internal {
        uint256 remainder = price - evalFee;
        vm.startPrank(who);
        usdc.approve(address(market), remainder);
        market.confirm(listingId);
        vm.stopPrank();
    }

    function testListReserveCancel_BackToActive() public {
        uint256 listingId = _listDefault();

        // listing is active
        assertEq(market.getActiveListingIds().length, 1);

        _reserve(listingId, buyer);

        // after reserve, removed from active
        assertEq(market.getActiveListingIds().length, 0);

        // cancel
        vm.prank(buyer);
        market.cancel(listingId);

        // back to ACTIVE and cleared
        MemonexMarket.Listing memory l = market.getListing(listingId);
        assertEq(uint256(l.status), uint256(MemonexMarket.ListingStatus.ACTIVE));
        assertEq(l.buyer, address(0));
        assertEq(l.reservedAt, 0);
        assertEq(l.evalFeePaid, 0);
        assertEq(l.buyerPubKey.length, 0);

        // seller credited eval fee
        assertEq(market.balanceOf(seller), evalFee);

        // active again
        assertEq(market.getActiveListingIds().length, 1);

        // seller can withdraw
        vm.prank(seller);
        market.withdraw(evalFee);
        assertEq(usdc.balanceOf(seller), evalFee);
    }

    function testListReserveExpire_BackToActive() public {
        uint256 listingId = _listDefault();
        _reserve(listingId, buyer);

        // too early
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(MemonexMarket.ReserveWindowStillActive.selector);
        market.expireReserve(listingId);

        // after window
        vm.warp(block.timestamp + 1);
        vm.prank(other);
        market.expireReserve(listingId);

        MemonexMarket.Listing memory l = market.getListing(listingId);
        assertEq(uint256(l.status), uint256(MemonexMarket.ListingStatus.ACTIVE));
        assertEq(l.buyer, address(0));
        assertEq(market.balanceOf(seller), evalFee);
        assertEq(market.getActiveListingIds().length, 1);
    }

    function testReserve_RevertsOnSelfBuy() public {
        uint256 listingId = _listDefault();

        vm.expectRevert(MemonexMarket.CannotSelfBuy.selector);
        vm.prank(seller);
        market.reserve(listingId, hex"010203");
    }

    function testFullFlow_ReserveConfirmDeliver_Completed() public {
        uint256 listingId = _listDefault();

        _reserve(listingId, buyer);
        _confirm(listingId, buyer);

        // deliver by non-seller fails
        vm.expectRevert(MemonexMarket.NotSeller.selector);
        vm.prank(other);
        market.deliver(listingId, "ref");

        // deliver by seller succeeds
        vm.prank(seller);
        market.deliver(listingId, "encKeyBlob");

        MemonexMarket.Listing memory l = market.getListing(listingId);
        assertEq(uint256(l.status), uint256(MemonexMarket.ListingStatus.COMPLETED));
        assertEq(l.deliveredAt > 0, true);
        assertEq(keccak256(bytes(l.deliveryRef)), keccak256(bytes("encKeyBlob")));

        uint256 fee = (price * market.PLATFORM_FEE_BPS()) / 10_000;
        uint256 sellerProceeds = price - fee;

        assertEq(market.balanceOf(seller), sellerProceeds);
        assertEq(market.balanceOf(platform), fee);

        // platform fee only collected on deliver
        vm.prank(platform);
        market.withdraw(fee);
        assertEq(usdc.balanceOf(platform), fee);
    }

    function testRefundFlow_TimeoutRefund_BackToActive() public {
        uint256 listingId = _listDefault();
        _reserve(listingId, buyer);
        _confirm(listingId, buyer);

        // too early
        vm.expectRevert(MemonexMarket.DeliveryWindowActive.selector);
        market.claimRefund(listingId);

        // after deadline
        vm.warp(block.timestamp + deliveryWindow + 1);
        vm.prank(other);
        market.claimRefund(listingId);

        // listing reset
        MemonexMarket.Listing memory l = market.getListing(listingId);
        assertEq(uint256(l.status), uint256(MemonexMarket.ListingStatus.ACTIVE));
        assertEq(l.buyer, address(0));

        // buyer credited full amount
        assertEq(market.balanceOf(buyer), price);
        assertEq(market.balanceOf(seller), 0);
        assertEq(market.balanceOf(platform), 0);

        // buyer withdraw
        vm.prank(buyer);
        market.withdraw(price);
        assertEq(usdc.balanceOf(buyer), 1_000e6); // got refund back

        assertEq(market.getActiveListingIds().length, 1);
    }

    function testEvalFeeValidation_RevertsOutsideBounds() public {
        // too low (<1%)
        uint256 lowEval = (price * market.MIN_EVAL_FEE_BPS()) / 10_000 - 1;
        vm.expectRevert(MemonexMarket.InvalidEvalFee.selector);
        vm.prank(seller);
        market.listMemory(keccak256("c"), "p", "e", price, lowEval, deliveryWindow);

        // too high (>20%)
        uint256 highEval = (price * market.MAX_EVAL_FEE_BPS()) / 10_000 + 1;
        vm.expectRevert(MemonexMarket.InvalidEvalFee.selector);
        vm.prank(seller);
        market.listMemory(keccak256("c"), "p", "e", price, highEval, deliveryWindow);
    }

    function testAccessControl_OnlyBuyerCancel_OnlyBuyerConfirm() public {
        uint256 listingId = _listDefault();
        _reserve(listingId, buyer);

        vm.expectRevert(MemonexMarket.NotBuyer.selector);
        vm.prank(other);
        market.cancel(listingId);

        vm.expectRevert(MemonexMarket.NotBuyer.selector);
        vm.prank(other);
        market.confirm(listingId);
    }

    function testConfirm_RevertsAfterReserveWindow() public {
        uint256 listingId = _listDefault();
        _reserve(listingId, buyer);

        vm.warp(block.timestamp + 2 hours + 1);

        uint256 remainder = price - evalFee;
        vm.startPrank(buyer);
        usdc.approve(address(market), remainder);
        vm.expectRevert(MemonexMarket.ReserveWindowExpired.selector);
        market.confirm(listingId);
        vm.stopPrank();
    }

    function testCancelListing_OnlySellerAndOnlyActive() public {
        uint256 listingId = _listDefault();

        vm.expectRevert(MemonexMarket.NotSeller.selector);
        vm.prank(other);
        market.cancelListing(listingId);

        vm.prank(seller);
        market.cancelListing(listingId);

        MemonexMarket.Listing memory l = market.getListing(listingId);
        assertEq(uint256(l.status), uint256(MemonexMarket.ListingStatus.CANCELLED));
        assertEq(market.getActiveListingIds().length, 0);

        // cannot reserve cancelled listing
        vm.startPrank(buyer);
        usdc.approve(address(market), evalFee);
        vm.expectRevert(MemonexMarket.InvalidStatus.selector);
        market.reserve(listingId, hex"01");
        vm.stopPrank();
    }
}
