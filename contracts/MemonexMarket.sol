// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IEAS} from "./interfaces/IEAS.sol";

/// @title MemonexMarket
/// @notice Trustless two-phase unlock marketplace for AI agent memories.
/// @dev Protocol:
///      - Seller lists memory (ACTIVE)
///      - Buyer reserves by paying evalFee + providing pubkey (RESERVED)
///      - Buyer confirms by paying remainder within 2 hours (CONFIRMED)
///      - Seller delivers encrypted key ref within deliveryWindow (COMPLETED)
///      - Liveness: anyone can expire stale reserve or claim refund on non-delivery.
contract MemonexMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Constants (per API.md)
    // ------------------------------------------------------------------

    uint256 public constant MIN_EVAL_FEE_BPS = 100; // 1%
    uint256 public constant MAX_EVAL_FEE_BPS = 2000; // 20%
    uint256 public constant PLATFORM_FEE_BPS = 200; // 2% (only on successful delivery)
    uint256 public constant MIN_PRICE = 1e6; // 1 USDC (6 decimals)
    uint32 public constant RESERVE_WINDOW = 2 hours;
    uint32 public constant DEFAULT_DELIVERY_WINDOW = 6 hours;

    // ------------------------------------------------------------------
    // Errors (per API.md + a few MVP additions)
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
        bytes32 contentHash;
        string previewCID;
        string encryptedCID;
        uint256 price;
        uint256 evalFee;
        uint32 deliveryWindow;
        ListingStatus status;

        // Phase 1: Reserve
        address buyer;
        bytes buyerPubKey;
        uint256 evalFeePaid;
        uint256 reservedAt;

        // Phase 2: Confirm
        uint256 remainderPaid;
        uint256 confirmedAt;

        // Delivery
        string deliveryRef;
        uint256 deliveredAt;
    }

    struct SellerStats {
        uint256 totalSales;
        uint256 totalVolume;
        uint256 avgDeliveryTime; // seconds
        uint256 refundCount;
        uint256 cancelCount;
    }

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    IERC20 public immutable usdc;
    IEAS public immutable eas;

    /// @notice EAS schema UID for completion attestations (can be bytes32(0) for MVP).
    bytes32 public immutable settlementSchemaUID;

    /// @notice Where platform fees accrue (withdrawable via balances + withdraw())
    address public immutable platform;

    uint256 public nextListingId = 1;

    mapping(uint256 listingId => Listing) private _listings;

    mapping(address seller => SellerStats) private _sellerStats;

    mapping(address account => uint256) private _balances;

    mapping(address seller => uint256[] listingIds) private _sellerListings;
    mapping(address buyer => uint256[] listingIds) private _buyerPurchases;

    // Active listings set (for getActiveListingIds)
    uint256[] private _activeIds;
    mapping(uint256 listingId => uint256 indexPlusOne) private _activeIndex;

    // ------------------------------------------------------------------
    // Events (per API.md)
    // ------------------------------------------------------------------

    event MemoryListed(
        uint256 indexed listingId,
        address indexed seller,
        uint256 price,
        uint256 evalFee,
        bytes32 contentHash
    );

    event MemoryReserved(uint256 indexed listingId, address indexed buyer, uint256 evalFee);
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

    constructor(address usdc_, address eas_, bytes32 settlementSchemaUID_, address platform_) {
        if (usdc_ == address(0) || platform_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
        eas = IEAS(eas_);
        settlementSchemaUID = settlementSchemaUID_;
        platform = platform_;
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

    function getSellerStats(address seller) external view returns (SellerStats memory) {
        return _sellerStats[seller];
    }

    function getSellerListings(address seller) external view returns (uint256[] memory) {
        return _sellerListings[seller];
    }

    function getBuyerPurchases(address buyer) external view returns (uint256[] memory) {
        return _buyerPurchases[buyer];
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    // ------------------------------------------------------------------
    // Seller functions
    // ------------------------------------------------------------------

    function listMemory(
        bytes32 contentHash,
        string calldata previewCID,
        string calldata encryptedCID,
        uint256 priceUSDC,
        uint256 evalFeeUSDC,
        uint32 deliveryWindow
    ) external nonReentrant returns (uint256 listingId) {
        if (contentHash == bytes32(0)) revert InvalidContentHash();
        if (bytes(previewCID).length == 0) revert InvalidCID();
        if (bytes(encryptedCID).length == 0) revert InvalidCID();

        if (priceUSDC < MIN_PRICE) revert InvalidPrice();

        // delivery window: 0 => default; otherwise must be >= 1 hour (API.md)
        uint32 window = deliveryWindow == 0 ? DEFAULT_DELIVERY_WINDOW : deliveryWindow;
        if (window < 1 hours) revert InvalidDeliveryWindow();

        // Eval fee bounds: 1% - 20% of price (BPS).
        // Note: API.md mentions "1% or $1"; this conflicts with MIN_PRICE=1 USDC.
        // MVP follows the protocol requirement: 1% - 20% of price.
        uint256 minEval = (priceUSDC * MIN_EVAL_FEE_BPS) / 10_000;
        uint256 maxEval = (priceUSDC * MAX_EVAL_FEE_BPS) / 10_000;
        if (evalFeeUSDC < minEval || evalFeeUSDC > maxEval) revert InvalidEvalFee();

        listingId = nextListingId++;

        Listing storage l = _listings[listingId];
        l.seller = msg.sender;
        l.contentHash = contentHash;
        l.previewCID = previewCID;
        l.encryptedCID = encryptedCID;
        l.price = priceUSDC;
        l.evalFee = evalFeeUSDC;
        l.deliveryWindow = window;
        l.status = ListingStatus.ACTIVE;

        _sellerListings[msg.sender].push(listingId);
        _addActive(listingId);

        emit MemoryListed(listingId, msg.sender, priceUSDC, evalFeeUSDC, contentHash);
    }

    function cancelListing(uint256 listingId) external nonReentrant {
        Listing storage l = _requireListing(listingId);
        if (msg.sender != l.seller) revert NotSeller();
        if (l.status != ListingStatus.ACTIVE) revert InvalidStatus();

        l.status = ListingStatus.CANCELLED;
        _removeActive(listingId);

        emit ListingCancelled(listingId, msg.sender);
    }

    function deliver(uint256 listingId, string calldata deliveryRef) external nonReentrant {
        Listing storage l = _requireListing(listingId);
        if (msg.sender != l.seller) revert NotSeller();
        if (l.status != ListingStatus.CONFIRMED) revert InvalidStatus();

        // Must be within delivery deadline
        if (block.timestamp > l.confirmedAt + uint256(l.deliveryWindow)) revert DeliveryWindowExpired();

        l.deliveryRef = deliveryRef;
        l.deliveredAt = block.timestamp;
        l.status = ListingStatus.COMPLETED;

        emit MemoryDelivered(listingId, deliveryRef);

        // Split proceeds (platform fee only on successful delivery)
        uint256 platformFee = (l.price * PLATFORM_FEE_BPS) / 10_000;
        uint256 sellerProceeds = l.price - platformFee;

        _balances[l.seller] += sellerProceeds;
        if (platform != address(0) && platformFee != 0) {
            _balances[platform] += platformFee;
        }

        // Update seller stats
        SellerStats storage s = _sellerStats[l.seller];
        uint256 saleIndex = s.totalSales;
        s.totalSales = saleIndex + 1;
        s.totalVolume += l.price;
        uint256 deliveryTime = l.deliveredAt - l.confirmedAt;
        // running integer average
        s.avgDeliveryTime = (s.avgDeliveryTime * saleIndex + deliveryTime) / (saleIndex + 1);

        // EAS attestation (best-effort for MVP)
        bytes32 uid = _attestCompletion(listingId, l, deliveryTime);
        emit MemoryCompleted(listingId, uid);
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

    function reserve(uint256 listingId, bytes calldata buyerPubKey) external nonReentrant {
        Listing storage l = _requireListing(listingId);
        if (l.status != ListingStatus.ACTIVE) revert InvalidStatus();
        if (msg.sender == l.seller) revert CannotSelfBuy();
        if (buyerPubKey.length == 0) revert InvalidPubKey();

        l.status = ListingStatus.RESERVED;
        l.buyer = msg.sender;
        l.buyerPubKey = buyerPubKey;
        l.evalFeePaid = l.evalFee;
        l.reservedAt = block.timestamp;

        _removeActive(listingId);

        emit MemoryReserved(listingId, msg.sender, l.evalFee);

        usdc.safeTransferFrom(msg.sender, address(this), l.evalFee);
    }

    function cancel(uint256 listingId) external nonReentrant {
        Listing storage l = _requireListing(listingId);
        if (l.status != ListingStatus.RESERVED) revert InvalidStatus();
        if (msg.sender != l.buyer) revert NotBuyer();

        // eval fee goes to seller
        _balances[l.seller] += l.evalFeePaid;

        // stats
        _sellerStats[l.seller].cancelCount += 1;

        emit ReserveCancelled(listingId, msg.sender);

        _resetToActive(l);
        _addActive(listingId);
    }

    function confirm(uint256 listingId) external nonReentrant {
        Listing storage l = _requireListing(listingId);
        if (l.status != ListingStatus.RESERVED) revert InvalidStatus();
        if (msg.sender != l.buyer) revert NotBuyer();

        if (block.timestamp > l.reservedAt + uint256(RESERVE_WINDOW)) revert ReserveWindowExpired();

        uint256 remainder = l.price - l.evalFeePaid;

        l.status = ListingStatus.CONFIRMED;
        l.remainderPaid = remainder;
        l.confirmedAt = block.timestamp;

        _buyerPurchases[msg.sender].push(listingId);

        emit MemoryConfirmed(listingId, msg.sender, l.evalFeePaid + remainder);

        usdc.safeTransferFrom(msg.sender, address(this), remainder);
    }

    // ------------------------------------------------------------------
    // Liveness functions (anyone)
    // ------------------------------------------------------------------

    function expireReserve(uint256 listingId) external nonReentrant {
        Listing storage l = _requireListing(listingId);
        if (l.status != ListingStatus.RESERVED) revert InvalidStatus();

        if (block.timestamp <= l.reservedAt + uint256(RESERVE_WINDOW)) revert ReserveWindowStillActive();

        // eval fee goes to seller
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

        uint256 amount = l.evalFeePaid + l.remainderPaid;
        address buyer = l.buyer;

        // refund to buyer balance
        _balances[buyer] += amount;

        // seller stats
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
        // State reset requirements: clear buyer/timestamps/etc.
        l.buyer = address(0);
        delete l.buyerPubKey;
        l.evalFeePaid = 0;
        l.reservedAt = 0;
        l.remainderPaid = 0;
        l.confirmedAt = 0;
        delete l.deliveryRef;
        l.deliveredAt = 0;

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
        if (address(eas) == address(0) || settlementSchemaUID == bytes32(0)) {
            return bytes32(0);
        }

        bytes memory data = abi.encode(l.seller, l.buyer, listingId, l.price, deliveryTime, l.contentHash);

        IEAS.AttestationRequestData memory reqData = IEAS.AttestationRequestData({
            recipient: l.seller,
            expirationTime: 0,
            revocable: false,
            refUID: bytes32(0),
            data: data,
            value: 0
        });

        IEAS.AttestationRequest memory req = IEAS.AttestationRequest({schema: settlementSchemaUID, data: reqData});

        try eas.attest(req) returns (bytes32 out) {
            uid = out;
        } catch {
            uid = bytes32(0);
        }
    }
}
