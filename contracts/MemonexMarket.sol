// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {IEAS} from "./interfaces/IEAS.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {IReputationRegistry} from "./interfaces/IReputationRegistry.sol";
import {IValidationRegistry} from "./interfaces/IValidationRegistry.sol";

/// @title MemonexMarket
/// @notice Trustless two-phase unlock marketplace for AI agent memories.
/// @dev Protocol:
///      - Seller lists memory (ACTIVE)
///      - Buyer reserves by paying evalFee + providing pubkey (RESERVED)
///      - Buyer confirms by paying remainder within reserveWindow (CONFIRMED)
///      - Seller delivers encrypted key ref within deliveryWindow (COMPLETED)
///      - Liveness: anyone can expire stale reserve or claim refund on non-delivery.
contract MemonexMarket is ReentrancyGuard, Ownable, Pausable, IERC721Receiver {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    uint256 public constant MIN_EVAL_FEE_BPS = 100; // 1%
    uint256 public constant MAX_EVAL_FEE_BPS = 2000; // 20%
    uint256 public constant MIN_PRICE = 1e6; // 1 USDC (6 decimals)

    uint16 public constant MAX_PLATFORM_FEE_BPS = 500; // 5%
    uint16 public constant MAX_DISCOUNT_BPS = 10000; // 100% (allows free updates)

    uint32 public constant DEFAULT_RESERVE_WINDOW = 2 hours;
    uint32 public constant DEFAULT_DELIVERY_WINDOW = 6 hours;
    uint32 public constant RATING_WINDOW = 7 days;

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error ZeroAddress();
    error InvalidPrice();
    error InvalidDeliveryWindow();
    error NotSeller();
    error NotBuyer();
    error InvalidStatus();
    error CannotSelfBuy();
    error InvalidContentHash();
    error InvalidCID();
    error ReserveWindowExpired();
    error ReserveWindowStillActive();
    error DeliveryWindowActive();
    error DeliveryWindowExpired();
    error InsufficientBalance();

    error ListingNotFound(uint256 listingId);
    error InvalidEvalFee();
    error InvalidPubKey();
    error InvalidPlatformFeeBps();
    error InvalidReserveWindow();
    error InvalidDiscountBps();
    error InvalidPrevListing();
    error InvalidRating();
    error RatingWindowExpired();
    error AlreadyRated();

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    enum ListingStatus {
        ACTIVE,
        RESERVED,
        CONFIRMED,
        COMPLETED,
        CANCELLED,
        REFUNDED
    }

    struct Listing {
        address seller;
        uint256 sellerAgentId;
        bytes32 contentHash;
        string previewCID;
        string encryptedCID;
        uint256 price; // base price (no discount)
        uint256 evalFee; // base eval fee (no discount)
        uint32 deliveryWindow;
        ListingStatus status;

        // Versioning
        uint256 prevListingId; // 0 if none
        uint16 discountBps; // discount for eligible buyers

        // Phase 1: Reserve
        address buyer;
        bytes buyerPubKey; // MUST be 32 bytes
        uint256 salePrice; // final price after discount
        uint256 evalFeePaid; // eval fee after discount
        uint32 reserveWindow; // snapshot of global reserveWindow
        uint256 reservedAt;

        // Phase 2: Confirm
        uint256 remainderPaid; // salePrice - evalFeePaid
        uint256 confirmedAt;

        // Delivery
        string deliveryRef;
        uint256 deliveredAt;
        bytes32 completionAttestationUid;

        // Buyer rating
        uint8 rating; // 1-5, 0=unrated
        uint64 ratedAt;
    }

    struct SellerStats {
        uint256 totalSales;
        uint256 totalVolume;
        uint256 avgDeliveryTime; // seconds
        uint256 refundCount;
        uint256 cancelCount;
        uint256 totalRatingSum; // sum of all ratings
        uint256 ratingCount; // number of ratings
    }

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    IERC20 public immutable usdc;
    IEAS public immutable eas;
    IIdentityRegistry public immutable identityRegistry;
    IReputationRegistry public immutable reputationRegistry;
    IValidationRegistry public immutable validationRegistry;

    /// @notice EAS schema UID for completion attestations (can be bytes32(0) for MVP).
    bytes32 public immutable completionSchemaUID;

    /// @notice EAS schema UID for rating attestations (can be bytes32(0) to disable).
    bytes32 public immutable ratingSchemaUID;

    /// @notice Where platform fees accrue (withdrawable via balances + withdraw())
    address public platform;

    /// @notice Platform fee in basis points.
    uint16 public platformFeeBps;

    /// @notice Global reserve window (seconds) for new reservations.
    uint32 public reserveWindow;

    uint256 public nextListingId = 1;

    mapping(uint256 listingId => Listing) private _listings;

    mapping(address seller => SellerStats) private _sellerStats;

    mapping(address account => uint256) private _balances;

    mapping(address seller => uint256[] listingIds) private _sellerListings;
    mapping(address buyer => uint256[] listingIds) private _buyerPurchases;

    /// @notice Cached ERC-8004 agentId per seller (set via registerSeller)
    mapping(address seller => uint256) private _sellerAgentIds;

    // Active listings set (for getActiveListingIds)
    uint256[] private _activeIds;
    mapping(uint256 listingId => uint256 indexPlusOne) private _activeIndex;

    // Purchase tracking for discounts
    mapping(uint256 listingId => mapping(address buyer => bool)) private _hasPurchased;

    /// @notice Stored validation request hashes for delivered listings
    mapping(uint256 listingId => bytes32) private _validationRequestHashes;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event PlatformFeeUpdated(uint16 oldBps, uint16 newBps);
    event PlatformUpdated(address indexed oldPlatform, address indexed newPlatform);
    event ReserveWindowUpdated(uint32 oldWindow, uint32 newWindow);

    event DiscountUpdated(uint256 indexed listingId, uint16 oldBps, uint16 newBps);

    event RatingSubmitted(uint256 indexed listingId, address indexed buyer, uint8 rating);
    event SellerRegistered(address indexed seller, uint256 indexed agentId);
    event ReputationSubmitted(uint256 indexed listingId, uint256 indexed agentId, uint8 rating);
    event ValidationRecorded(uint256 indexed listingId, uint256 indexed agentId, bytes32 requestHash);

    event MemoryListed(
        uint256 indexed listingId,
        address indexed seller,
        uint256 price,
        uint256 evalFee,
        bytes32 contentHash,
        uint256 prevListingId,
        uint16 discountBps
    );

    event MemoryReserved(uint256 indexed listingId, address indexed buyer, uint256 evalFeePaid, uint256 salePrice);
    event ListingCancelled(uint256 indexed listingId, address indexed seller);
    event ReserveCancelled(uint256 indexed listingId, address indexed buyer);
    event ReserveExpired(uint256 indexed listingId, address indexed buyer);
    event MemoryConfirmed(uint256 indexed listingId, address indexed buyer, uint256 totalPaid);
    event MemoryDelivered(uint256 indexed listingId, string deliveryRef);
    event MemoryCompleted(uint256 indexed listingId, bytes32 attestationUid);
    event RefundClaimed(uint256 indexed listingId, address indexed buyer, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    constructor(
        address usdc_,
        address eas_,
        bytes32 completionSchemaUID_,
        bytes32 ratingSchemaUID_,
        address platform_,
        uint16 platformFeeBps_,
        uint32 reserveWindow_,
        address identityRegistry_,
        address reputationRegistry_,
        address validationRegistry_
    ) Ownable(msg.sender) {
        if (usdc_ == address(0) || platform_ == address(0)) revert ZeroAddress();
        if (platformFeeBps_ > MAX_PLATFORM_FEE_BPS) revert InvalidPlatformFeeBps();
        if (reserveWindow_ == 0) revert InvalidReserveWindow();

        usdc = IERC20(usdc_);
        eas = IEAS(eas_);
        identityRegistry = IIdentityRegistry(identityRegistry_);
        reputationRegistry = IReputationRegistry(reputationRegistry_);
        validationRegistry = IValidationRegistry(validationRegistry_);
        completionSchemaUID = completionSchemaUID_;
        ratingSchemaUID = ratingSchemaUID_;
        platform = platform_;
        platformFeeBps = platformFeeBps_;
        reserveWindow = reserveWindow_;
    }

    // ------------------------------------------------------------------
    // Admin / Owner
    // ------------------------------------------------------------------

    /// @notice Pause marketplace actions (list/reserve/confirm/deliver/cancelListing/updateDiscountBps).
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause marketplace actions.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Update platform fee in BPS (max MAX_PLATFORM_FEE_BPS).
    function setPlatformFeeBps(uint16 newBps) external onlyOwner {
        if (newBps > MAX_PLATFORM_FEE_BPS) revert InvalidPlatformFeeBps();
        uint16 oldBps = platformFeeBps;
        platformFeeBps = newBps;
        emit PlatformFeeUpdated(oldBps, newBps);
    }

    /// @notice Update platform fee recipient.
    function setPlatform(address newPlatform) external onlyOwner {
        if (newPlatform == address(0)) revert ZeroAddress();
        address oldPlatform = platform;
        platform = newPlatform;
        emit PlatformUpdated(oldPlatform, newPlatform);
    }

    /// @notice Update global reserve window for new reservations.
    function setReserveWindow(uint32 newWindow) external onlyOwner {
        if (newWindow == 0) revert InvalidReserveWindow();
        uint32 oldWindow = reserveWindow;
        reserveWindow = newWindow;
        emit ReserveWindowUpdated(oldWindow, newWindow);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function getListing(uint256 listingId) external view returns (Listing memory) {
        Listing memory l = _listings[listingId];
        if (l.seller == address(0)) revert ListingNotFound(listingId);
        return l;
    }

    function getActiveListingIds() external view returns (uint256[] memory) {
        return _activeIds;
    }

    function getActiveListingIds(uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        uint256 total = _activeIds.length;
        if (offset >= total || limit == 0) {
            return new uint256[](0);
        }
        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 size = end - offset;
        uint256[] memory page = new uint256[](size);
        for (uint256 i = 0; i < size; i++) {
            page[i] = _activeIds[offset + i];
        }
        return page;
    }

    function getVersionHistory(uint256 listingId) external view returns (uint256[] memory) {
        Listing storage l = _listings[listingId];
        if (l.seller == address(0)) revert ListingNotFound(listingId);

        uint256 count = 0;
        uint256 cursor = listingId;
        while (cursor != 0) {
            Listing storage current = _listings[cursor];
            if (current.seller == address(0)) revert ListingNotFound(cursor);
            count++;
            cursor = current.prevListingId;
        }

        uint256[] memory ids = new uint256[](count);
        cursor = listingId;
        for (uint256 i = count; i > 0; i--) {
            Listing storage current = _listings[cursor];
            ids[i - 1] = cursor;
            cursor = current.prevListingId;
        }

        return ids;
    }

    function getSellerStats(address seller) external view returns (SellerStats memory) {
        return _sellerStats[seller];
    }

    function getSellerListings(address seller) external view returns (uint256[] memory) {
        return _sellerListings[seller];
    }

    function getBuyerPurchases(address buyer) external view returns (uint256[] memory) {
        return _buyerPurchases[buyer];
    }

    /// @notice Get seller's cached ERC-8004 agent ID (0 if not linked).
    function getSellerAgentId(address seller) external view returns (uint256) {
        return _sellerAgentIds[seller];
    }

    /// @notice Get seller's reputation from ERC-8004 reputation registry.
    function getSellerReputation(address seller)
        external
        view
        returns (uint256 count, int256 summaryValue, uint8 summaryValueDecimals)
    {
        uint256 agentId = _sellerAgentIds[seller];
        if (agentId == 0 || address(reputationRegistry) == address(0)) return (0, 0, 0);
        try reputationRegistry.getSummary(agentId, new address[](0), "memonex", "memory-trade")
            returns (uint256 c, int256 v, uint8 d)
        {
            return (c, v, d);
        } catch {
            return (0, 0, 0);
        }
    }

    /// @notice Get seller's validation summary from ERC-8004 validation registry.
    function getSellerValidationSummary(address seller)
        external
        view
        returns (uint256 count, uint256 averageResponse)
    {
        uint256 agentId = _sellerAgentIds[seller];
        if (agentId == 0 || address(validationRegistry) == address(0)) return (0, 0);
        address[] memory validators = new address[](1);
        validators[0] = address(this);
        try validationRegistry.getSummary(agentId, validators, "memonex-delivery")
            returns (uint256 c, uint256 a)
        {
            return (c, a);
        } catch {
            return (0, 0);
        }
    }

    /// @notice Get the validation request hash for a delivered listing.
    function getValidationRequestHash(uint256 listingId) external view returns (bytes32) {
        return _validationRequestHashes[listingId];
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    // ------------------------------------------------------------------
    // Seller functions
    // ------------------------------------------------------------------

    /// @dev Accept ERC-721 tokens (required for ERC-8004 identity minting via _safeMint).
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice Register seller in ERC-8004 identity registry.
    function registerSeller(string calldata agentURI) external returns (uint256 agentId) {
        if (address(identityRegistry) == address(0)) revert ZeroAddress();
        agentId = identityRegistry.register(agentURI);
        address owner = identityRegistry.ownerOf(agentId);
        if (owner == address(this)) {
            IERC721(address(identityRegistry)).transferFrom(address(this), msg.sender, agentId);
        }
        _sellerAgentIds[msg.sender] = agentId;
        emit SellerRegistered(msg.sender, agentId);
    }

    function listMemory(
        bytes32 contentHash,
        string calldata previewCID,
        string calldata encryptedCID,
        uint256 priceUSDC,
        uint256 evalFeeUSDC,
        uint32 deliveryWindow,
        uint256 prevListingId,
        uint16 discountBps
    ) external whenNotPaused nonReentrant returns (uint256 listingId) {
        if (contentHash == bytes32(0)) revert InvalidContentHash();
        if (bytes(previewCID).length == 0) revert InvalidCID();
        if (bytes(encryptedCID).length == 0) revert InvalidCID();

        if (priceUSDC < MIN_PRICE) revert InvalidPrice();

        uint32 window = deliveryWindow == 0 ? DEFAULT_DELIVERY_WINDOW : deliveryWindow;
        if (window < 1 hours) revert InvalidDeliveryWindow();

        uint256 minEval = (priceUSDC * MIN_EVAL_FEE_BPS) / 10_000;
        uint256 maxEval = (priceUSDC * MAX_EVAL_FEE_BPS) / 10_000;
        if (evalFeeUSDC < minEval || evalFeeUSDC > maxEval) revert InvalidEvalFee();

        if (discountBps > MAX_DISCOUNT_BPS) revert InvalidDiscountBps();
        if (prevListingId == 0 && discountBps != 0) revert InvalidPrevListing();

        listingId = nextListingId++;

        if (prevListingId != 0) {
            Listing storage prev = _listings[prevListingId];
            if (prev.seller == address(0)) revert ListingNotFound(prevListingId);
            if (prev.seller != msg.sender) revert NotSeller();
            if (prevListingId >= listingId) revert InvalidPrevListing();
        }

        uint256 sellerAgentId = _sellerAgentIds[msg.sender];

        Listing storage l = _listings[listingId];
        l.seller = msg.sender;
        l.sellerAgentId = sellerAgentId;
        l.contentHash = contentHash;
        l.previewCID = previewCID;
        l.encryptedCID = encryptedCID;
        l.price = priceUSDC;
        l.evalFee = evalFeeUSDC;
        l.deliveryWindow = window;
        l.status = ListingStatus.ACTIVE;
        l.prevListingId = prevListingId;
        l.discountBps = discountBps;

        _sellerListings[msg.sender].push(listingId);
        _addActive(listingId);

        emit MemoryListed(listingId, msg.sender, priceUSDC, evalFeeUSDC, contentHash, prevListingId, discountBps);
    }

    function cancelListing(uint256 listingId) external whenNotPaused nonReentrant {
        Listing storage l = _requireListing(listingId);
        if (msg.sender != l.seller) revert NotSeller();
        if (l.status != ListingStatus.ACTIVE) revert InvalidStatus();

        l.status = ListingStatus.CANCELLED;
        _removeActive(listingId);

        emit ListingCancelled(listingId, msg.sender);
    }

    function updateDiscountBps(uint256 listingId, uint16 newBps) external whenNotPaused nonReentrant {
        Listing storage l = _requireListing(listingId);
        if (msg.sender != l.seller) revert NotSeller();
        if (l.status != ListingStatus.ACTIVE) revert InvalidStatus();
        if (l.prevListingId == 0) revert InvalidPrevListing();
        if (newBps > MAX_DISCOUNT_BPS) revert InvalidDiscountBps();

        uint16 oldBps = l.discountBps;
        l.discountBps = newBps;

        emit DiscountUpdated(listingId, oldBps, newBps);
    }

    function deliver(uint256 listingId, string calldata deliveryRef)
        external
        whenNotPaused
        nonReentrant
    {
        Listing storage l = _requireListing(listingId);
        if (msg.sender != l.seller) revert NotSeller();
        if (l.status != ListingStatus.CONFIRMED) revert InvalidStatus();

        if (block.timestamp > l.confirmedAt + uint256(l.deliveryWindow)) revert DeliveryWindowExpired();

        l.deliveryRef = deliveryRef;
        l.deliveredAt = block.timestamp;
        l.status = ListingStatus.COMPLETED;

        emit MemoryDelivered(listingId, deliveryRef);

        uint256 platformFee = (l.salePrice * platformFeeBps) / 10_000;
        uint256 sellerProceeds = l.salePrice - platformFee;

        _balances[l.seller] += sellerProceeds;
        if (platform != address(0) && platformFee != 0) {
            _balances[platform] += platformFee;
        }

        SellerStats storage s = _sellerStats[l.seller];
        uint256 saleIndex = s.totalSales;
        s.totalSales = saleIndex + 1;
        s.totalVolume += l.salePrice;
        uint256 deliveryTime = l.deliveredAt - l.confirmedAt;
        s.avgDeliveryTime = (s.avgDeliveryTime * saleIndex + deliveryTime) / (saleIndex + 1);

        _hasPurchased[listingId][l.buyer] = true;

        bytes32 uid = _attestCompletion(listingId, l, deliveryTime);
        l.completionAttestationUid = uid;
        emit MemoryCompleted(listingId, uid);

        if (address(validationRegistry) != address(0) && l.sellerAgentId != 0) {
            bytes32 reqHash = keccak256(abi.encodePacked(address(this), l.sellerAgentId, l.contentHash, listingId));
            try validationRegistry.validationRequest(address(this), l.sellerAgentId, "", reqHash) {
                try validationRegistry.validationResponse(reqHash, 1, "", l.contentHash, "memonex-delivery") {
                    _validationRequestHashes[listingId] = reqHash;
                    emit ValidationRecorded(listingId, l.sellerAgentId, reqHash);
                } catch {
                    // best-effort
                }
            } catch {
                // best-effort
            }
        }
    }

    function withdraw(uint256 amount) external nonReentrant {
        uint256 bal = _balances[msg.sender];
        if (amount == 0 || amount > bal) revert InsufficientBalance();

        _balances[msg.sender] = bal - amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawal(msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Buyer functions
    // ------------------------------------------------------------------

    function reserve(uint256 listingId, bytes calldata buyerPubKey) external whenNotPaused nonReentrant {
        Listing storage l = _requireListing(listingId);
        if (l.status != ListingStatus.ACTIVE) revert InvalidStatus();
        if (msg.sender == l.seller) revert CannotSelfBuy();
        if (buyerPubKey.length != 32) revert InvalidPubKey();

        uint16 discount = 0;
        if (l.prevListingId != 0 && _hasPurchased[l.prevListingId][msg.sender]) {
            discount = l.discountBps;
        }

        uint256 salePrice = l.price - (l.price * discount) / 10_000;
        uint256 evalFeePaid = l.evalFee - (l.evalFee * discount) / 10_000;

        l.status = ListingStatus.RESERVED;
        l.buyer = msg.sender;
        l.buyerPubKey = buyerPubKey;
        l.salePrice = salePrice;
        l.evalFeePaid = evalFeePaid;
        l.reserveWindow = reserveWindow;
        l.reservedAt = block.timestamp;

        _removeActive(listingId);

        emit MemoryReserved(listingId, msg.sender, evalFeePaid, salePrice);

        usdc.safeTransferFrom(msg.sender, address(this), evalFeePaid);
    }

    function cancel(uint256 listingId) external nonReentrant {
        Listing storage l = _requireListing(listingId);
        if (l.status != ListingStatus.RESERVED) revert InvalidStatus();
        if (msg.sender != l.buyer) revert NotBuyer();

        _balances[l.seller] += l.evalFeePaid;

        _sellerStats[l.seller].cancelCount += 1;

        emit ReserveCancelled(listingId, msg.sender);

        _resetToActive(l);
        _addActive(listingId);
    }

    function confirm(uint256 listingId) external whenNotPaused nonReentrant {
        Listing storage l = _requireListing(listingId);
        if (l.status != ListingStatus.RESERVED) revert InvalidStatus();
        if (msg.sender != l.buyer) revert NotBuyer();

        if (block.timestamp > l.reservedAt + uint256(l.reserveWindow)) revert ReserveWindowExpired();

        uint256 remainder = l.salePrice - l.evalFeePaid;

        l.status = ListingStatus.CONFIRMED;
        l.remainderPaid = remainder;
        l.confirmedAt = block.timestamp;

        _buyerPurchases[msg.sender].push(listingId);

        emit MemoryConfirmed(listingId, msg.sender, l.evalFeePaid + remainder);

        usdc.safeTransferFrom(msg.sender, address(this), remainder);
    }

    function rateSeller(uint256 listingId, uint8 rating) external nonReentrant {
        Listing storage l = _requireListing(listingId);
        if (l.status != ListingStatus.COMPLETED) revert InvalidStatus();
        if (msg.sender != l.buyer) revert NotBuyer();
        if (rating < 1 || rating > 5) revert InvalidRating();
        if (block.timestamp > l.deliveredAt + uint256(RATING_WINDOW)) revert RatingWindowExpired();
        if (l.rating != 0) revert AlreadyRated();

        l.rating = rating;
        l.ratedAt = uint64(block.timestamp);

        SellerStats storage s = _sellerStats[l.seller];
        s.totalRatingSum += rating;
        s.ratingCount += 1;

        emit RatingSubmitted(listingId, msg.sender, rating);

        _attestRating(listingId, l, rating);

        if (address(reputationRegistry) != address(0) && l.sellerAgentId != 0) {
            try reputationRegistry.giveFeedback(
                l.sellerAgentId, int128(int8(rating)), 0, "memonex", "memory-trade", "", "", bytes32(0)
            ) {
                emit ReputationSubmitted(listingId, l.sellerAgentId, rating);
            } catch {
                // best-effort
            }
        }
    }

    // ------------------------------------------------------------------
    // Liveness functions (anyone)
    // ------------------------------------------------------------------

    function expireReserve(uint256 listingId) external nonReentrant {
        Listing storage l = _requireListing(listingId);
        if (l.status != ListingStatus.RESERVED) revert InvalidStatus();

        if (block.timestamp <= l.reservedAt + uint256(l.reserveWindow)) revert ReserveWindowStillActive();

        _balances[l.seller] += l.evalFeePaid;

        address buyer = l.buyer;

        emit ReserveExpired(listingId, buyer);

        _resetToActive(l);
        _addActive(listingId);
    }

    function claimRefund(uint256 listingId) external nonReentrant {
        Listing storage l = _requireListing(listingId);
        if (l.status != ListingStatus.CONFIRMED) revert InvalidStatus();

        if (block.timestamp <= l.confirmedAt + uint256(l.deliveryWindow)) revert DeliveryWindowActive();

        uint256 amount = l.salePrice;
        address buyer = l.buyer;

        _balances[buyer] += amount;

        _sellerStats[l.seller].refundCount += 1;

        emit RefundClaimed(listingId, buyer, amount);

        _resetToActive(l);
        _addActive(listingId);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _requireListing(uint256 listingId) internal view returns (Listing storage l) {
        l = _listings[listingId];
        if (l.seller == address(0)) revert ListingNotFound(listingId);
    }

    function _resetToActive(Listing storage l) internal {
        l.buyer = address(0);
        delete l.buyerPubKey;
        l.salePrice = 0;
        l.evalFeePaid = 0;
        l.reserveWindow = 0;
        l.reservedAt = 0;
        l.remainderPaid = 0;
        l.confirmedAt = 0;
        delete l.deliveryRef;
        l.deliveredAt = 0;
        l.completionAttestationUid = bytes32(0);
        l.rating = 0;
        l.ratedAt = 0;

        l.status = ListingStatus.ACTIVE;
    }

    function _addActive(uint256 listingId) internal {
        if (_activeIndex[listingId] != 0) return;
        _activeIds.push(listingId);
        _activeIndex[listingId] = _activeIds.length; // index+1
    }

    function _removeActive(uint256 listingId) internal {
        uint256 idxPlusOne = _activeIndex[listingId];
        if (idxPlusOne == 0) return;

        uint256 idx = idxPlusOne - 1;
        uint256 lastId = _activeIds[_activeIds.length - 1];

        if (idx != _activeIds.length - 1) {
            _activeIds[idx] = lastId;
            _activeIndex[lastId] = idx + 1;
        }

        _activeIds.pop();
        _activeIndex[listingId] = 0;
    }

    function _attestCompletion(uint256 listingId, Listing storage l, uint256 deliveryTime)
        internal
        returns (bytes32 uid)
    {
        if (address(eas) == address(0) || completionSchemaUID == bytes32(0)) {
            return bytes32(0);
        }

        bytes memory data = abi.encode(l.seller, l.buyer, listingId, l.salePrice, deliveryTime, l.contentHash);

        IEAS.AttestationRequestData memory reqData = IEAS.AttestationRequestData({
            recipient: l.seller,
            expirationTime: 0,
            revocable: false,
            refUID: bytes32(0),
            data: data,
            value: 0
        });

        IEAS.AttestationRequest memory req = IEAS.AttestationRequest({schema: completionSchemaUID, data: reqData});

        try eas.attest(req) returns (bytes32 out) {
            uid = out;
        } catch {
            uid = bytes32(0);
        }
    }

    function _attestRating(uint256 listingId, Listing storage l, uint8 rating) internal {
        if (address(eas) == address(0) || ratingSchemaUID == bytes32(0)) {
            return;
        }

        bytes memory data = abi.encode(l.seller, l.buyer, listingId, rating, l.salePrice, l.prevListingId);

        IEAS.AttestationRequestData memory reqData = IEAS.AttestationRequestData({
            recipient: l.seller,
            expirationTime: 0,
            revocable: false,
            refUID: l.completionAttestationUid,
            data: data,
            value: 0
        });

        IEAS.AttestationRequest memory req = IEAS.AttestationRequest({schema: ratingSchemaUID, data: reqData});

        try eas.attest(req) {
            // best-effort, swallow errors
        } catch {
            // no-op
        }
    }
}
