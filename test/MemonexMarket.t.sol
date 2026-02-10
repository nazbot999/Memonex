// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {MemonexMarket} from "../contracts/MemonexMarket.sol";
import {MockUSDC} from "../contracts/mocks/MockUSDC.sol";
import {MockEAS} from "../contracts/mocks/MockEAS.sol";
import {MockIdentityRegistry} from "../contracts/mocks/MockIdentityRegistry.sol";
import {MockReputationRegistry} from "../contracts/mocks/MockReputationRegistry.sol";
import {MockValidationRegistry} from "../contracts/mocks/MockValidationRegistry.sol";

contract MemonexMarketTest is Test {
    MockUSDC usdc;
    MockEAS eas;
    MockIdentityRegistry identityRegistry;
    MockReputationRegistry reputationRegistry;
    MockValidationRegistry validationRegistry;
    MemonexMarket market;

    address seller = address(0xA11CE);
    address buyer = address(0xB0B);
    address other = address(0xCAFE);
    address platform = address(0xFEE);
    address newPlatform = address(0xBEEF);

    bytes32 completionSchemaUID = keccak256("memonex.schema.v2");
    bytes32 ratingSchemaUID = keccak256("memonex.rating.v1");

    uint16 platformFeeBps = 200; // 2%
    uint32 reserveWindow = 2 hours;

    uint256 price = 10e6; // 10 USDC
    uint256 evalFee = 1e6; // 10% (within 1-20%)
    uint32 deliveryWindow = 6 hours;

    bytes defaultPubKey;

    function setUp() public {
        usdc = new MockUSDC(6);
        eas = new MockEAS();
        identityRegistry = new MockIdentityRegistry();
        reputationRegistry = new MockReputationRegistry();
        validationRegistry = new MockValidationRegistry();

        market = new MemonexMarket(
            address(usdc),
            address(eas),
            completionSchemaUID,
            ratingSchemaUID,
            platform,
            platformFeeBps,
            reserveWindow,
            address(identityRegistry),
            address(reputationRegistry),
            address(validationRegistry)
        );

        usdc.mint(buyer, 1_000e6);
        usdc.mint(other, 1_000e6);

        defaultPubKey = abi.encodePacked(bytes32(uint256(1)));

        vm.label(seller, "seller");
        vm.label(buyer, "buyer");
        vm.label(other, "other");
        vm.label(platform, "platform");
        vm.label(address(market), "market");
        vm.label(address(usdc), "usdc");
        vm.label(address(eas), "eas");
        vm.label(address(identityRegistry), "identityRegistry");
        vm.label(address(reputationRegistry), "reputationRegistry");
        vm.label(address(validationRegistry), "validationRegistry");
    }

    function _listDefault() internal returns (uint256 listingId) {
        vm.prank(seller);
        listingId = market.listMemory(
            keccak256("content"),
            "ipfs://preview",
            "ipfs://encrypted",
            price,
            evalFee,
            deliveryWindow,
            0,
            0
        );
    }

    function _listVersioned(uint256 prevListingId, uint16 discountBps) internal returns (uint256 listingId) {
        vm.prank(seller);
        listingId = market.listMemory(
            keccak256(abi.encodePacked("content", prevListingId)),
            "ipfs://preview",
            "ipfs://encrypted",
            price,
            evalFee,
            deliveryWindow,
            prevListingId,
            discountBps
        );
    }

    function _reserve(uint256 listingId, address who) internal {
        vm.startPrank(who);
        usdc.approve(address(market), evalFee);
        market.reserve(listingId, defaultPubKey);
        vm.stopPrank();
    }

    function _confirm(uint256 listingId, address who) internal {
        MemonexMarket.Listing memory l = market.getListing(listingId);
        uint256 remainder = l.salePrice - l.evalFeePaid;
        vm.startPrank(who);
        usdc.approve(address(market), remainder);
        market.confirm(listingId);
        vm.stopPrank();
    }

    function _complete(uint256 listingId, address who) internal {
        _reserve(listingId, who);
        _confirm(listingId, who);
        vm.prank(seller);
        market.deliver(listingId, "encKeyBlob");
    }

    function _registerSeller(address who) internal returns (uint256 agentId) {
        vm.prank(who);
        agentId = market.registerSeller("ipfs://agent");
    }

    function testListReserveCancel_BackToActive() public {
        uint256 listingId = _listDefault();

        assertEq(market.getActiveListingIds().length, 1);

        _reserve(listingId, buyer);

        assertEq(market.getActiveListingIds().length, 0);

        vm.prank(buyer);
        market.cancel(listingId);

        MemonexMarket.Listing memory l = market.getListing(listingId);
        assertEq(uint256(l.status), uint256(MemonexMarket.ListingStatus.ACTIVE));
        assertEq(l.buyer, address(0));
        assertEq(l.reservedAt, 0);
        assertEq(l.evalFeePaid, 0);
        assertEq(l.salePrice, 0);
        assertEq(l.buyerPubKey.length, 0);

        assertEq(market.balanceOf(seller), evalFee);

        assertEq(market.getActiveListingIds().length, 1);

        vm.prank(seller);
        market.withdraw(evalFee);
        assertEq(usdc.balanceOf(seller), evalFee);
    }

    function testListReserveExpire_BackToActive() public {
        uint256 listingId = _listDefault();
        _reserve(listingId, buyer);

        vm.warp(block.timestamp + reserveWindow - 1);
        vm.expectRevert(MemonexMarket.ReserveWindowStillActive.selector);
        market.expireReserve(listingId);

        vm.warp(block.timestamp + 2);
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
        market.reserve(listingId, defaultPubKey);
    }

    function testFullFlow_ReserveConfirmDeliver_Completed() public {
        uint256 listingId = _listDefault();

        _reserve(listingId, buyer);
        _confirm(listingId, buyer);

        vm.expectRevert(MemonexMarket.NotSeller.selector);
        vm.prank(other);
        market.deliver(listingId, "ref");

        vm.prank(seller);
        market.deliver(listingId, "encKeyBlob");

        MemonexMarket.Listing memory l = market.getListing(listingId);
        assertEq(uint256(l.status), uint256(MemonexMarket.ListingStatus.COMPLETED));
        assertEq(l.deliveredAt > 0, true);
        assertEq(keccak256(bytes(l.deliveryRef)), keccak256(bytes("encKeyBlob")));

        uint256 fee = (price * market.platformFeeBps()) / 10_000;
        uint256 sellerProceeds = price - fee;

        assertEq(market.balanceOf(seller), sellerProceeds);
        assertEq(market.balanceOf(platform), fee);

        vm.prank(platform);
        market.withdraw(fee);
        assertEq(usdc.balanceOf(platform), fee);
    }

    function testRefundFlow_TimeoutRefund_BackToActive() public {
        uint256 listingId = _listDefault();
        _reserve(listingId, buyer);
        _confirm(listingId, buyer);

        vm.expectRevert(MemonexMarket.DeliveryWindowActive.selector);
        market.claimRefund(listingId);

        vm.warp(block.timestamp + deliveryWindow + 1);
        vm.prank(other);
        market.claimRefund(listingId);

        MemonexMarket.Listing memory l = market.getListing(listingId);
        assertEq(uint256(l.status), uint256(MemonexMarket.ListingStatus.ACTIVE));
        assertEq(l.buyer, address(0));

        assertEq(market.balanceOf(buyer), price);
        assertEq(market.balanceOf(seller), 0);
        assertEq(market.balanceOf(platform), 0);

        vm.prank(buyer);
        market.withdraw(price);
        assertEq(usdc.balanceOf(buyer), 1_000e6);

        assertEq(market.getActiveListingIds().length, 1);
    }

    function testEvalFeeValidation_RevertsOutsideBounds() public {
        uint256 lowEval = (price * market.MIN_EVAL_FEE_BPS()) / 10_000 - 1;
        vm.expectRevert(MemonexMarket.InvalidEvalFee.selector);
        vm.prank(seller);
        market.listMemory(keccak256("c"), "p", "e", price, lowEval, deliveryWindow, 0, 0);

        uint256 highEval = (price * market.MAX_EVAL_FEE_BPS()) / 10_000 + 1;
        vm.expectRevert(MemonexMarket.InvalidEvalFee.selector);
        vm.prank(seller);
        market.listMemory(keccak256("c"), "p", "e", price, highEval, deliveryWindow, 0, 0);
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

        vm.warp(block.timestamp + reserveWindow + 1);

        MemonexMarket.Listing memory l = market.getListing(listingId);
        uint256 remainder = l.salePrice - l.evalFeePaid;

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

        vm.startPrank(buyer);
        usdc.approve(address(market), evalFee);
        vm.expectRevert(MemonexMarket.InvalidStatus.selector);
        market.reserve(listingId, defaultPubKey);
        vm.stopPrank();
    }

    function testPauseBlocksActions() public {
        uint256 listingId = _listDefault();
        uint256 versioned = _listVersioned(listingId, 500);

        market.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(seller);
        market.listMemory(keccak256("x"), "p", "e", price, evalFee, deliveryWindow, 0, 0);

        vm.startPrank(buyer);
        usdc.approve(address(market), evalFee);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        market.reserve(listingId, defaultPubKey);
        vm.stopPrank();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(seller);
        market.cancelListing(listingId);

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(seller);
        market.updateDiscountBps(versioned, 600);
    }

    function testPauseBlocksConfirmAndDeliver() public {
        uint256 listingId = _listDefault();
        _reserve(listingId, buyer);

        market.pause();

        MemonexMarket.Listing memory l = market.getListing(listingId);
        uint256 remainder = l.salePrice - l.evalFeePaid;

        vm.startPrank(buyer);
        usdc.approve(address(market), remainder);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        market.confirm(listingId);
        vm.stopPrank();

        market.unpause();
        _confirm(listingId, buyer);

        market.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(seller);
        market.deliver(listingId, "ref");

        market.unpause();
        vm.prank(seller);
        market.deliver(listingId, "ref");
    }

    function testPauseAllowsCancelExpireRefundWithdraw() public {
        uint256 listingId = _listDefault();
        _reserve(listingId, buyer);

        market.pause();

        vm.prank(buyer);
        market.cancel(listingId);

        vm.prank(seller);
        market.withdraw(evalFee);
        assertEq(usdc.balanceOf(seller), evalFee);

        market.unpause();
        uint256 listingId2 = _listDefault();
        _reserve(listingId2, buyer);

        market.pause();
        vm.warp(block.timestamp + reserveWindow + 1);
        market.expireReserve(listingId2);

        market.unpause();
        uint256 listingId3 = _listDefault();
        _reserve(listingId3, buyer);
        _confirm(listingId3, buyer);

        market.pause();
        vm.warp(block.timestamp + deliveryWindow + 1);
        market.claimRefund(listingId3);
    }

    function testOwnerSettersAndCaps() public {
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, other));
        market.setPlatformFeeBps(100);

        uint16 maxBps = market.MAX_PLATFORM_FEE_BPS();
        vm.expectRevert(MemonexMarket.InvalidPlatformFeeBps.selector);
        market.setPlatformFeeBps(maxBps + 1);

        market.setPlatformFeeBps(250);
        assertEq(market.platformFeeBps(), 250);

        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, other));
        market.setPlatform(newPlatform);

        vm.expectRevert(MemonexMarket.ZeroAddress.selector);
        market.setPlatform(address(0));

        market.setPlatform(newPlatform);
        assertEq(market.platform(), newPlatform);

        vm.expectRevert(MemonexMarket.InvalidReserveWindow.selector);
        market.setReserveWindow(0);

        market.setReserveWindow(1 hours);
        assertEq(market.reserveWindow(), 1 hours);
    }

    function testReserveWindowSnapshot() public {
        market.setReserveWindow(1 hours);
        uint256 listingId = _listDefault();
        _reserve(listingId, buyer);

        market.setReserveWindow(10 hours);

        vm.warp(block.timestamp + 1 hours + 1);
        market.expireReserve(listingId);
    }

    function testGetActiveListingIdsPagination() public {
        _listDefault();
        uint256 id2 = _listDefault();
        uint256 id3 = _listDefault();
        _listDefault();
        uint256 id5 = _listDefault();

        uint256[] memory page = market.getActiveListingIds(1, 2);
        assertEq(page.length, 2);
        assertEq(page[0], id2);
        assertEq(page[1], id3);

        uint256[] memory page2 = market.getActiveListingIds(4, 10);
        assertEq(page2.length, 1);
        assertEq(page2[0], id5);

        uint256[] memory page3 = market.getActiveListingIds(10, 1);
        assertEq(page3.length, 0);
    }

    function testReserveRequires32BytePubkey() public {
        uint256 listingId = _listDefault();
        bytes memory badKey = new bytes(31);

        vm.startPrank(buyer);
        usdc.approve(address(market), evalFee);
        vm.expectRevert(MemonexMarket.InvalidPubKey.selector);
        market.reserve(listingId, badKey);
        vm.stopPrank();
    }

    function testVersionChainingDiscountHistoryAndValidation() public {
        uint256 v1 = _listDefault();
        _complete(v1, buyer);

        uint256 v2 = _listVersioned(v1, 1000); // 10%

        _reserve(v2, other);
        MemonexMarket.Listing memory lOther = market.getListing(v2);
        assertEq(lOther.salePrice, price);
        assertEq(lOther.evalFeePaid, evalFee);

        vm.prank(other);
        market.cancel(v2);

        _reserve(v2, buyer);
        MemonexMarket.Listing memory lBuyer = market.getListing(v2);
        uint256 expectedSale = price - (price * 1000) / 10_000;
        uint256 expectedEval = evalFee - (evalFee * 1000) / 10_000;
        assertEq(lBuyer.salePrice, expectedSale);
        assertEq(lBuyer.evalFeePaid, expectedEval);

        uint256 v3 = _listVersioned(v2, 500);
        uint256[] memory history = market.getVersionHistory(v3);
        assertEq(history.length, 3);
        assertEq(history[0], v1);
        assertEq(history[1], v2);
        assertEq(history[2], v3);

        vm.prank(other);
        vm.expectRevert(MemonexMarket.NotSeller.selector);
        market.listMemory(keccak256("c"), "p", "e", price, evalFee, deliveryWindow, v3, 100);

        vm.prank(seller);
        vm.expectRevert(MemonexMarket.InvalidPrevListing.selector);
        market.listMemory(keccak256("c2"), "p", "e", price, evalFee, deliveryWindow, 0, 100);
    }

    function testUpdateDiscountBpsOnlyActiveVersioned() public {
        uint256 v1 = _listDefault();
        uint256 v2 = _listVersioned(v1, 1000);

        vm.prank(other);
        vm.expectRevert(MemonexMarket.NotSeller.selector);
        market.updateDiscountBps(v2, 1200);

        vm.prank(seller);
        market.updateDiscountBps(v2, 1200);
        MemonexMarket.Listing memory l = market.getListing(v2);
        assertEq(l.discountBps, 1200);

        _reserve(v2, buyer);
        vm.prank(seller);
        vm.expectRevert(MemonexMarket.InvalidStatus.selector);
        market.updateDiscountBps(v2, 1300);

        vm.prank(seller);
        vm.expectRevert(MemonexMarket.InvalidPrevListing.selector);
        market.updateDiscountBps(v1, 500);
    }

    function testRateSeller_ValidRatingUpdatesStats() public {
        uint256 listingId = _listDefault();
        _complete(listingId, buyer);

        vm.prank(buyer);
        market.rateSeller(listingId, 5);

        MemonexMarket.Listing memory l = market.getListing(listingId);
        assertEq(l.rating, 5);
        assertGt(l.ratedAt, 0);

        MemonexMarket.SellerStats memory stats = market.getSellerStats(seller);
        assertEq(stats.totalRatingSum, 5);
        assertEq(stats.ratingCount, 1);
    }

    function testRateSeller_RevertsOnInvalidConditions() public {
        uint256 listingId = _listDefault();
        _complete(listingId, buyer);

        vm.prank(other);
        vm.expectRevert(MemonexMarket.NotBuyer.selector);
        market.rateSeller(listingId, 4);

        vm.prank(buyer);
        vm.expectRevert(MemonexMarket.InvalidRating.selector);
        market.rateSeller(listingId, 0);

        vm.prank(buyer);
        vm.expectRevert(MemonexMarket.InvalidRating.selector);
        market.rateSeller(listingId, 6);

        vm.warp(block.timestamp + market.RATING_WINDOW() + 1);
        vm.prank(buyer);
        vm.expectRevert(MemonexMarket.RatingWindowExpired.selector);
        market.rateSeller(listingId, 4);
    }

    function testRateSeller_AlreadyRated() public {
        uint256 listingId = _listDefault();
        _complete(listingId, buyer);

        vm.prank(buyer);
        market.rateSeller(listingId, 4);

        vm.prank(buyer);
        vm.expectRevert(MemonexMarket.AlreadyRated.selector);
        market.rateSeller(listingId, 5);
    }

    function testRateSeller_RevertsBeforeCompletion() public {
        uint256 listingId = _listDefault();
        _reserve(listingId, buyer);
        _confirm(listingId, buyer);

        vm.prank(buyer);
        vm.expectRevert(MemonexMarket.InvalidStatus.selector);
        market.rateSeller(listingId, 4);
    }

    function testSettlementUsesDiscountedSalePrice() public {
        uint256 v1 = _listDefault();
        _complete(v1, buyer);

        uint256 sellerBal = market.balanceOf(seller);
        if (sellerBal > 0) {
            vm.prank(seller);
            market.withdraw(sellerBal);
        }
        uint256 platformBal = market.balanceOf(platform);
        if (platformBal > 0) {
            vm.prank(platform);
            market.withdraw(platformBal);
        }

        uint256 v2 = _listVersioned(v1, 2000); // 20%
        _reserve(v2, buyer);
        _confirm(v2, buyer);
        vm.prank(seller);
        market.deliver(v2, "encKeyBlob");

        uint256 expectedSale = price - (price * 2000) / 10_000;
        uint256 expectedFee = (expectedSale * market.platformFeeBps()) / 10_000;
        uint256 expectedSeller = expectedSale - expectedFee;

        assertEq(market.balanceOf(seller), expectedSeller);
        assertEq(market.balanceOf(platform), expectedFee);
    }

    function testRegisterSeller_GetsAgentId() public {
        uint256 agentId = _registerSeller(seller);
        // Use test-only helper (not in spec) for verification
        assertEq(identityRegistry.agentIdOf(seller), agentId);
        assertEq(market.getSellerAgentId(seller), agentId);
    }

    function testListMemory_StoresSellerAgentId() public {
        uint256 agentId = _registerSeller(seller);
        uint256 listingId = _listDefault();

        MemonexMarket.Listing memory l = market.getListing(listingId);
        assertEq(l.sellerAgentId, agentId);
    }

    function testRateSeller_SubmitsReputation() public {
        uint256 agentId = _registerSeller(seller);
        uint256 listingId = _listDefault();
        _complete(listingId, buyer);

        vm.prank(buyer);
        market.rateSeller(listingId, 5);

        assertEq(reputationRegistry.feedbackCount(), 1);
        (
            int128 value, uint8 valueDecimals, string memory tag1, string memory tag2,
            , , , bool revoked,
        ) = reputationRegistry.readFeedback(agentId, address(market), 0);
        assertEq(value, int128(5));
        assertEq(valueDecimals, 0);
        assertEq(tag1, "memonex");
        assertEq(tag2, "memory-trade");
        assertEq(revoked, false);
    }

    function testDeliver_RecordsValidation() public {
        uint256 agentId = _registerSeller(seller);
        uint256 listingId = _listDefault();
        _reserve(listingId, buyer);
        _confirm(listingId, buyer);

        vm.prank(seller);
        market.deliver(listingId, "encKeyBlob");

        assertEq(validationRegistry.validationCount(), 1);

        // Check validation request hash was stored
        bytes32 reqHash = market.getValidationRequestHash(listingId);
        assertGt(uint256(reqHash), 0);

        // Verify the validation status via the mock
        (
            address requestor, address validator, uint256 recordedAgentId,
            uint8 response, string memory tag, bool responded, ,
        ) = validationRegistry.getValidationStatus(reqHash);
        assertEq(requestor, address(market));
        assertEq(validator, address(market));
        assertEq(recordedAgentId, agentId);
        assertEq(response, 1);
        assertEq(tag, "memonex-delivery");
        assertEq(responded, true);
    }

    function testZeroRegistries_SkipCalls() public {
        MemonexMarket marketNoReg = new MemonexMarket(
            address(usdc),
            address(eas),
            completionSchemaUID,
            ratingSchemaUID,
            platform,
            platformFeeBps,
            reserveWindow,
            address(0),
            address(0),
            address(0)
        );

        vm.prank(seller);
        uint256 listingId = marketNoReg.listMemory(
            keccak256("content"),
            "ipfs://preview",
            "ipfs://encrypted",
            price,
            evalFee,
            deliveryWindow,
            0,
            0
        );

        MemonexMarket.Listing memory l = marketNoReg.getListing(listingId);
        assertEq(l.sellerAgentId, 0);

        vm.startPrank(buyer);
        usdc.approve(address(marketNoReg), evalFee);
        marketNoReg.reserve(listingId, defaultPubKey);
        vm.stopPrank();

        MemonexMarket.Listing memory l2 = marketNoReg.getListing(listingId);
        uint256 remainder = l2.salePrice - l2.evalFeePaid;

        vm.startPrank(buyer);
        usdc.approve(address(marketNoReg), remainder);
        marketNoReg.confirm(listingId);
        vm.stopPrank();

        vm.prank(seller);
        marketNoReg.deliver(listingId, "encKeyBlob");

        vm.prank(buyer);
        marketNoReg.rateSeller(listingId, 4);

        MemonexMarket.Listing memory l3 = marketNoReg.getListing(listingId);
        assertEq(l3.rating, 4);
    }

    function testRegistryRevert_DoesNotRevert() public {
        uint256 agentId = _registerSeller(seller);
        uint256 listingId = _listDefault();
        MemonexMarket.Listing memory l = market.getListing(listingId);
        assertEq(l.sellerAgentId, agentId);

        reputationRegistry.setShouldRevert(true);
        validationRegistry.setShouldRevert(true);

        _reserve(listingId, buyer);
        _confirm(listingId, buyer);

        vm.prank(seller);
        market.deliver(listingId, "encKeyBlob");

        vm.prank(buyer);
        market.rateSeller(listingId, 5);

        MemonexMarket.Listing memory l2 = market.getListing(listingId);
        assertEq(l2.rating, 5);
        assertEq(reputationRegistry.feedbackCount(), 0);
        assertEq(validationRegistry.validationCount(), 0);
    }

    function testGetSellerReputation_QueriesSummary() public {
        _registerSeller(seller);
        uint256 listingId = _listDefault();
        _complete(listingId, buyer);

        vm.prank(buyer);
        market.rateSeller(listingId, 5);

        (uint256 count, int256 summaryValue, ) = market.getSellerReputation(seller);
        assertEq(count, 1);
        assertEq(summaryValue, 5);
    }

    function testGetSellerValidationSummary() public {
        _registerSeller(seller);
        uint256 listingId = _listDefault();
        _reserve(listingId, buyer);
        _confirm(listingId, buyer);

        vm.prank(seller);
        market.deliver(listingId, "encKeyBlob");

        (uint256 count, uint256 avgResponse) = market.getSellerValidationSummary(seller);
        assertEq(count, 1);
        assertEq(avgResponse, 1);
    }

    function testGetValidationRequestHash() public {
        _registerSeller(seller);
        uint256 listingId = _listDefault();
        _reserve(listingId, buyer);
        _confirm(listingId, buyer);

        vm.prank(seller);
        market.deliver(listingId, "encKeyBlob");

        bytes32 reqHash = market.getValidationRequestHash(listingId);
        assertGt(uint256(reqHash), 0);
    }

    function testListMemory_NoAgentIdOfFallback() public {
        // List without registering — should get agentId 0 (no reverse lookup fallback)
        uint256 listingId = _listDefault();
        MemonexMarket.Listing memory l = market.getListing(listingId);
        assertEq(l.sellerAgentId, 0);
        assertEq(market.getSellerAgentId(seller), 0);
    }

    function testRegisterSeller_SafeMintWorks() public {
        // MockIdentityRegistry now uses _safeMint, which requires IERC721Receiver on MemonexMarket.
        // This test confirms registration succeeds and the token is transferred to the seller.
        vm.prank(seller);
        uint256 agentId = market.registerSeller("ipfs://agent-safe");

        assertGt(agentId, 0);
        assertEq(market.getSellerAgentId(seller), agentId);
        // Token should have been transferred from market to seller
        assertEq(identityRegistry.ownerOf(agentId), seller);
    }

    function testRegisterSeller_SupportsInterface() public {
        // Verify MemonexMarket reports ERC721Receiver support via ERC-165
        bytes4 erc721ReceiverSelector = bytes4(keccak256("onERC721Received(address,address,uint256,bytes)"));
        bytes4 result = market.onERC721Received(address(0), address(0), 0, "");
        assertEq(result, erc721ReceiverSelector);
    }

    function testRegisterSeller_TokenOwnedBySeller() public {
        // Confirms the identity NFT ends up owned by the original seller, not the market contract
        vm.prank(seller);
        uint256 agentId = market.registerSeller("ipfs://agent-owner-check");

        // NFT must be owned by the seller, not by the market
        assertEq(identityRegistry.ownerOf(agentId), seller);
        assertTrue(identityRegistry.ownerOf(agentId) != address(market));

        // Second seller should also get their own NFT
        vm.prank(buyer);
        uint256 agentId2 = market.registerSeller("ipfs://agent-buyer");
        assertEq(identityRegistry.ownerOf(agentId2), buyer);
        assertTrue(agentId != agentId2);
    }
}
