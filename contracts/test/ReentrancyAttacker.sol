// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IMultiSigTimelockWallet {
    function execute(uint256 id) external;
}

/**
 * @title ReentrancyAttacker
 * @notice Helper contract for T20 that attempts to re-enter execute() when receiving ETH.
 */
contract ReentrancyAttacker {
    address public immutable wallet;
    uint256 public targetTxId;
    uint256 public attackCount;
    bool public reentrantCallSucceeded;

    constructor(address wallet_) {
        wallet = wallet_;
    }

    function setTargetTxId(uint256 id) external {
        targetTxId = id;
    }

    receive() external payable {
        attackCount += 1;
        // Try to re-enter wallet.execute(targetTxId) during ETH receipt.
        // We capture the boolean result so we can inspect that the reentrant call failed
        // while allowing the legitimate outer transfer to finish once.
        (bool ok, ) = wallet.call(abi.encodeWithSelector(IMultiSigTimelockWallet.execute.selector, targetTxId));
        reentrantCallSucceeded = ok;
    }
}
