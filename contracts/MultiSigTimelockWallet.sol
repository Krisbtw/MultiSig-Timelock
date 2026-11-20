// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MultiSigTimelockWallet
 * @author Blockchain Lab Mini Project
 * @notice A multi-signature smart-contract wallet with mandatory time-locked execution,
 *         revocation, emergency cancellation, expiry grace period, and self-governed settings.
 * @dev Standalone single-file contract with zero external imports so it compiles directly
 *      in both Remix IDE and Hardhat (Solidity ^0.8.20).
 */
contract MultiSigTimelockWallet {
    // =========================================================================
    // Constants
    // =========================================================================

    // Security decision: Cap owners at 10 so loops over the owners array never hit block gas limits.
    uint256 public constant MAX_OWNERS = 10;

    // Security decision: Expire queued transactions after 7 days so stale proposals cannot execute unexpectedly later.
    uint256 public constant GRACE_PERIOD = 7 days;

    // Security decision: Enforce at least a 10-second delay so the time lock cannot be bypassed with zero delay.
    uint256 public constant MIN_DELAY = 10 seconds;

    // Security decision: Cap the delay at 30 days so funds are not accidentally locked for years by a typo.
    uint256 public constant MAX_DELAY = 30 days;

    // =========================================================================
    // Custom Errors
    // =========================================================================

    error NotOwner();
    error NotSelf();
    error TxNotFound();
    error AlreadyApproved();
    error NotApproved();
    error NotQueued();
    error TooEarly();
    error Expired();
    error InvalidThreshold();
    error InvalidOwner();
    error InvalidDelay();
    error InvalidStatus();
    error ExecutionFailed();
    error InsufficientBalance();
    error Reentrancy();

    // =========================================================================
    // Types
    // =========================================================================

    enum Status {
        None,       // 0: Default uninitialized state
        Pending,    // 1: Submitted, waiting for enough approvals
        Queued,     // 2: Threshold reached, time-lock countdown running
        Executed,   // 3: Executed on-chain
        Cancelled   // 4: Cancelled by proposer or M-of-N owners
        // Note: 5 (Expired) is derived in getStatus() when Status is Queued and block.timestamp > unlockTime + GRACE_PERIOD
    }

    struct Tx {
        address to;
        uint256 value;
        bytes data;
        string note;
        address proposer;
        uint256 unlockTime;
        Status status;
    }

    // =========================================================================
    // State Variables
    // =========================================================================

    address[] public owners;
    mapping(address => bool) public isOwner;
    uint256 public threshold;
    uint256 public delay;
    uint256 public txCount;

    mapping(uint256 => Tx) public transactions;
    mapping(uint256 => mapping(address => bool)) public approved;
    mapping(uint256 => mapping(address => bool)) public cancelVoted;

    // Security decision: Use a simple boolean lock to block reentrant calls during external ETH transfers.
    bool private _locked;

    // =========================================================================
    // Events
    // =========================================================================

    event Deposited(address indexed sender, uint256 amount, uint256 balanceAfter);
    event Submitted(
        uint256 indexed id,
        address indexed proposer,
        address indexed to,
        uint256 value,
        bytes data,
        string note
    );
    event Approved(uint256 indexed id, address indexed owner);
    event Revoked(uint256 indexed id, address indexed owner);
    event Queued(uint256 indexed id, uint256 unlockTime);
    event Executed(
        uint256 indexed id,
        address indexed executor,
        address indexed to,
        uint256 value,
        bytes data
    );
    event Cancelled(uint256 indexed id, address indexed by);
    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    event ThresholdChanged(uint256 newThreshold);
    event DelayChanged(uint256 newDelay);

    // =========================================================================
    // Modifiers
    // =========================================================================

    // Security decision: Restrict wallet actions strictly to active addresses in the isOwner mapping.
    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner();
        _;
    }

    // Security decision: Restrict governance changes to calls originating from this wallet's own execute() function.
    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    // Security decision: Prevent reentrant calls into execute() when interacting with untrusted external contracts.
    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    // =========================================================================
    // Constructor & ETH Receiver
    // =========================================================================

    /**
     * @notice Initializes the multi-signature time-locked wallet with owners, threshold, and time-lock delay.
     * @param owners_ Initial list of owner addresses (must be between 3 and 10 unique non-zero addresses).
     * @param threshold_ Number of approvals required to queue a transaction (must be between 2 and owners_.length).
     * @param delay_ Time in seconds a queued transaction must wait before execution (10 seconds to 30 days).
     */
    constructor(address[] memory owners_, uint256 threshold_, uint256 delay_) {
        // Security decision: Require between 3 and MAX_OWNERS owners for true multi-party control and bounded loops.
        if (owners_.length < 3 || owners_.length > MAX_OWNERS) revert InvalidOwner();

        // Security decision: Require threshold >= 2 so no single owner can ever queue a transaction alone.
        if (threshold_ < 2 || threshold_ > owners_.length) revert InvalidThreshold();

        // Security decision: Enforce minimum and maximum time-lock delay boundaries at deployment.
        if (delay_ < MIN_DELAY || delay_ > MAX_DELAY) revert InvalidDelay();

        for (uint256 i = 0; i < owners_.length; i++) {
            address owner = owners_[i];
            // Security decision: Reject zero addresses and duplicate owners so one person cannot hold two votes.
            if (owner == address(0) || isOwner[owner]) revert InvalidOwner();
            isOwner[owner] = true;
            owners.push(owner);
        }

        threshold = threshold_;
        delay = delay_;
    }

    /**
     * @notice Allows anyone to deposit ETH into the wallet and logs the new balance.
     */
    receive() external payable {
        emit Deposited(msg.sender, msg.value, address(this).balance);
    }

    // =========================================================================
    // Core Transaction Lifecycle Functions
    // =========================================================================

    /**
     * @notice Submits a new transaction proposal and automatically records the proposer's approval.
     * @param to Destination address for the transaction (cannot be the zero address).
     * @param value Amount of ETH (in wei) to send with the call.
     * @param data Encoded function call data (empty bytes for plain ETH transfers).
     * @param note Human-readable description explaining the purpose of the proposal.
     * @return id Unique ID assigned to the newly created transaction.
     */
    function submit(
        address to,
        uint256 value,
        bytes calldata data,
        string calldata note
    ) external onlyOwner returns (uint256 id) {
        // Security decision: Prevent accidental ETH burn or invalid calls to the zero address.
        if (to == address(0)) revert InvalidOwner();

        id = txCount;
        txCount += 1;

        transactions[id] = Tx({
            to: to,
            value: value,
            data: data,
            note: note,
            proposer: msg.sender,
            unlockTime: 0,
            status: Status.Pending
        });

        // Security decision: Auto-approve for the proposer, which is safe because threshold is always >= 2.
        approved[id][msg.sender] = true;

        emit Submitted(id, msg.sender, to, value, data, note);
        emit Approved(id, msg.sender);
    }

    /**
     * @notice Approves a pending or queued transaction; starts the time-lock countdown when threshold is first met.
     * @param id Transaction ID to approve.
     */
    function approve(uint256 id) external onlyOwner {
        if (id >= txCount) revert TxNotFound();
        Tx storage txn = transactions[id];

        // Security decision: Only allow approvals on active Pending or Queued transactions.
        if (txn.status != Status.Pending && txn.status != Status.Queued) revert InvalidStatus();

        // Security decision: Block an owner from approving the same transaction more than once.
        if (approved[id][msg.sender]) revert AlreadyApproved();

        approved[id][msg.sender] = true;
        emit Approved(id, msg.sender);

        // Security decision: Start unlockTime only when status transitions from Pending to Queued so extra approvals do not reset the timer.
        if (txn.status == Status.Pending && _approvalCount(id) >= threshold) {
            txn.status = Status.Queued;
            txn.unlockTime = block.timestamp + delay;
            emit Queued(id, txn.unlockTime);
        }
    }

    /**
     * @notice Withdraws the caller's previous approval from a Pending or Queued transaction.
     * @param id Transaction ID from which to revoke approval.
     */
    function revoke(uint256 id) external onlyOwner {
        if (id >= txCount) revert TxNotFound();
        Tx storage txn = transactions[id];

        if (txn.status != Status.Pending && txn.status != Status.Queued) revert InvalidStatus();

        // Security decision: Only an owner who has currently approved the transaction can revoke.
        if (!approved[id][msg.sender]) revert NotApproved();

        approved[id][msg.sender] = false;
        emit Revoked(id, msg.sender);

        // Security decision: Demote Queued back to Pending and clear unlockTime if valid approvals drop below threshold.
        if (txn.status == Status.Queued && _approvalCount(id) < threshold) {
            txn.status = Status.Pending;
            txn.unlockTime = 0;
        }
    }

    /**
     * @notice Demotes a Queued transaction back to Pending if active owner approvals fell below threshold
     *         (for example, after an owner was removed or the threshold was raised).
     * @param id Transaction ID to synchronize.
     */
    function sync(uint256 id) external {
        if (id >= txCount) revert TxNotFound();
        Tx storage txn = transactions[id];

        // Security decision: Allow anyone to clean up stale Queued status if governance changes reduced valid approvals below threshold.
        if (txn.status == Status.Queued && _approvalCount(id) < threshold) {
            txn.status = Status.Pending;
            txn.unlockTime = 0;
        }
    }

    /**
     * @notice Executes a Queued transaction once the time-lock delay has passed and before the grace period expires.
     * @param id Transaction ID to execute.
     */
    function execute(uint256 id) external onlyOwner nonReentrant {
        if (id >= txCount) revert TxNotFound();
        Tx storage txn = transactions[id];

        // Security decision: Only Queued transactions can be executed, preventing double execution.
        if (txn.status != Status.Queued) revert NotQueued();

        // Security decision: Re-verify active owner approvals at execution time in case an owner was removed or threshold increased.
        if (_approvalCount(id) < threshold) revert NotApproved();

        // Security decision: Enforce the mandatory waiting window before funds or governance calls can run.
        if (block.timestamp < txn.unlockTime) revert TooEarly();

        // Security decision: Reject stale transactions that were not executed within GRACE_PERIOD after unlocking.
        if (block.timestamp > txn.unlockTime + GRACE_PERIOD) revert Expired();

        // Security decision: Check wallet ETH balance explicitly for a clear error before making the external call.
        if (address(this).balance < txn.value) revert InsufficientBalance();

        // Security decision: Set status to Executed BEFORE the external call (Checks-Effects-Interactions) to prevent reentrancy.
        txn.status = Status.Executed;

        // Security decision: Roll back the entire transaction (including status change) if the downstream call fails.
        (bool ok, ) = txn.to.call{value: txn.value}(txn.data);
        if (!ok) revert ExecutionFailed();

        emit Executed(id, msg.sender, txn.to, txn.value, txn.data);
    }

    /**
     * @notice Cancels a Pending or Queued transaction immediately if called by the proposer,
     *         or records a cancellation vote that cancels the transaction once threshold votes are reached.
     * @param id Transaction ID to cancel or vote to cancel.
     */
    function voteCancel(uint256 id) external onlyOwner {
        if (id >= txCount) revert TxNotFound();
        Tx storage txn = transactions[id];

        // Security decision: Only Pending or Queued proposals can be cancelled; Executed or already Cancelled ones cannot change.
        if (txn.status != Status.Pending && txn.status != Status.Queued) revert InvalidStatus();

        // Security decision: Allow the original proposer to cancel immediately if they spot a mistake.
        if (msg.sender == txn.proposer) {
            txn.status = Status.Cancelled;
            txn.unlockTime = 0;
            emit Cancelled(id, msg.sender);
            return;
        }

        // Security decision: Prevent a non-proposer owner from casting duplicate cancellation votes.
        if (cancelVoted[id][msg.sender]) revert AlreadyApproved();
        cancelVoted[id][msg.sender] = true;

        // Security decision: Allow M-of-N owners to defensively cancel a malicious or compromised proposer's transaction.
        if (_cancelCount(id) >= threshold) {
            txn.status = Status.Cancelled;
            txn.unlockTime = 0;
            emit Cancelled(id, msg.sender);
        }
    }

    // =========================================================================
    // Self-Governance Functions (Callable only via an executed wallet proposal)
    // =========================================================================

    /**
     * @notice Adds a new owner to the wallet. Must be invoked via an executed transaction targeting this wallet.
     * @param newOwner Address of the new owner to add.
     */
    function addOwner(address newOwner) external onlySelf {
        // Security decision: Enforce non-zero address, uniqueness, and MAX_OWNERS cap when adding an owner.
        if (newOwner == address(0) || isOwner[newOwner] || owners.length >= MAX_OWNERS) {
            revert InvalidOwner();
        }

        isOwner[newOwner] = true;
        owners.push(newOwner);
        emit OwnerAdded(newOwner);
    }

    /**
     * @notice Removes an existing owner from the wallet using swap-and-pop. Must be invoked via an executed proposal.
     * @param ownerToRemove Address of the existing owner to remove.
     */
    function removeOwner(address ownerToRemove) external onlySelf {
        // Security decision: Keep at least 3 owners in the wallet even after removing an owner.
        if (!isOwner[ownerToRemove] || owners.length <= 3) revert InvalidOwner();

        // Security decision: Ensure threshold remains achievable (threshold <= new owner count) so the wallet never locks up.
        if (threshold > owners.length - 1) revert InvalidThreshold();

        isOwner[ownerToRemove] = false;

        uint256 len = owners.length;
        for (uint256 i = 0; i < len; i++) {
            if (owners[i] == ownerToRemove) {
                owners[i] = owners[len - 1];
                owners.pop();
                break;
            }
        }

        emit OwnerRemoved(ownerToRemove);
    }

    /**
     * @notice Updates the approval threshold M. Must be invoked via an executed transaction targeting this wallet.
     * @param newThreshold New approval threshold (2 <= newThreshold <= owners.length).
     */
    function changeThreshold(uint256 newThreshold) external onlySelf {
        // Security decision: Enforce 2 <= newThreshold <= owners.length so governance cannot set an impossible or 1-of-N threshold.
        if (newThreshold < 2 || newThreshold > owners.length) revert InvalidThreshold();

        threshold = newThreshold;
        emit ThresholdChanged(newThreshold);
    }

    /**
     * @notice Updates the time-lock delay in seconds. Must be invoked via an executed transaction targeting this wallet.
     * @param newDelay New time-lock delay in seconds (MIN_DELAY <= newDelay <= MAX_DELAY).
     */
    function changeDelay(uint256 newDelay) external onlySelf {
        // Security decision: Keep the time-lock delay within safe minimum and maximum bounds.
        if (newDelay < MIN_DELAY || newDelay > MAX_DELAY) revert InvalidDelay();

        delay = newDelay;
        emit DelayChanged(newDelay);
    }

    // =========================================================================
    // View & Helper Functions
    // =========================================================================

    /**
     * @notice Counts how many current owners have approved a given transaction.
     * @param id Transaction ID to query.
     * @return count Number of active owners who have approved transaction `id`.
     */
    function approvalCount(uint256 id) external view returns (uint256 count) {
        if (id >= txCount) revert TxNotFound();
        return _approvalCount(id);
    }

    /**
     * @notice Counts how many current owners have voted to cancel a given transaction.
     * @param id Transaction ID to query.
     * @return count Number of active owners who have voted to cancel transaction `id`.
     */
    function cancelCount(uint256 id) external view returns (uint256 count) {
        if (id >= txCount) revert TxNotFound();
        return _cancelCount(id);
    }

    /**
     * @notice Returns the full list of current owner addresses.
     * @return List of active owner addresses.
     */
    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    /**
     * @notice Returns all fields of a transaction along with its current dynamic approval and cancel-vote counts.
     * @param id Transaction ID to inspect.
     * @return to Destination address.
     * @return value ETH value in wei.
     * @return data Calldata bytes.
     * @return note Proposal description note.
     * @return proposer Address of the owner who submitted the proposal.
     * @return unlockTime Timestamp when the transaction unlocks (0 if not queued).
     * @return status Stored Status enum value.
     * @return approvals Dynamic count of approvals from current owners.
     * @return cancelVotes Dynamic count of cancel votes from current owners.
     */
    function getTransaction(uint256 id)
        external
        view
        returns (
            address to,
            uint256 value,
            bytes memory data,
            string memory note,
            address proposer,
            uint256 unlockTime,
            Status status,
            uint256 approvals,
            uint256 cancelVotes
        )
    {
        if (id >= txCount) revert TxNotFound();
        {
            Tx storage txn = transactions[id];
            to = txn.to;
            value = txn.value;
            data = txn.data;
            note = txn.note;
            proposer = txn.proposer;
            unlockTime = txn.unlockTime;
            status = txn.status;
        }
        approvals = _approvalCount(id);
        cancelVotes = _cancelCount(id);
    }

    /**
     * @notice Returns the effective status of a transaction as a uint8, where 5 indicates a derived Expired state.
     * @param id Transaction ID to query.
     * @return statusValue 1=Pending, 2=Queued, 3=Executed, 4=Cancelled, 5=Expired.
     */
    function getStatus(uint256 id) external view returns (uint8 statusValue) {
        if (id >= txCount) revert TxNotFound();
        if (isExpired(id)) {
            return 5;
        }
        return uint8(transactions[id].status);
    }

    /**
     * @notice Returns the number of seconds remaining until a Queued transaction unlocks, or 0 if not waiting.
     * @param id Transaction ID to query.
     * @return secondsLeft Seconds until unlockTime, or 0 if not Queued or already unlocked.
     */
    function timeLeft(uint256 id) external view returns (uint256 secondsLeft) {
        if (id >= txCount) revert TxNotFound();
        Tx storage txn = transactions[id];
        if (txn.status != Status.Queued || block.timestamp >= txn.unlockTime) {
            return 0;
        }
        return txn.unlockTime - block.timestamp;
    }

    /**
     * @notice Checks whether a Queued transaction has passed its 7-day execution grace period.
     * @param id Transaction ID to query.
     * @return expired True if status is Queued and block.timestamp > unlockTime + GRACE_PERIOD.
     */
    function isExpired(uint256 id) public view returns (bool expired) {
        if (id >= txCount) revert TxNotFound();
        Tx storage txn = transactions[id];
        return txn.status == Status.Queued && block.timestamp > txn.unlockTime + GRACE_PERIOD;
    }

    // =========================================================================
    // Internal Helpers
    // =========================================================================

    // Security decision: Compute approvals dynamically over current owners so removed owners' approvals are automatically ignored.
    function _approvalCount(uint256 id) internal view returns (uint256 count) {
        uint256 len = owners.length;
        for (uint256 i = 0; i < len; i++) {
            if (approved[id][owners[i]]) {
                count += 1;
            }
        }
    }

    // Security decision: Compute cancel votes dynamically over current owners so removed owners' votes are automatically ignored.
    function _cancelCount(uint256 id) internal view returns (uint256 count) {
        uint256 len = owners.length;
        for (uint256 i = 0; i < len; i++) {
            if (cancelVoted[id][owners[i]]) {
                count += 1;
            }
        }
    }
}
