// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ISystemContract} from "reactive-lib-omni/interfaces/ISystemContract.sol";

/// @notice Minimal stand-in for the Reactive Omni system contract (0x8888…8888) in Foundry tests.
/// @dev The official reactive-test-lib still targets the legacy system address, so we roll our own.
///      Tests `vm.etch` this code at 0x8888…8888 and then read the recorded calls back.
contract MockSystemContract {
    struct Sub {
        address subscriber;
        uint256 chainId;
        address contract_;
        uint256 topic0;
        uint256 topic1;
        uint256 topic2;
        uint256 topic3;
    }

    struct CallbackReq {
        address sender;
        uint256 chainId;
        address recipient;
        uint64 gasLimit;
        bytes payload;
    }

    Sub[] internal _subs;
    mapping(bytes32 => bool) public isSubscribed;
    CallbackReq[] internal _callbacks;

    receive() external payable {}

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    function subscribe(uint256 chainId, address c, uint256 t0, uint256 t1, uint256 t2, uint256 t3) external {
        _subs.push(Sub(msg.sender, chainId, c, t0, t1, t2, t3));
        isSubscribed[keccak256(abi.encode(msg.sender, chainId, c, t0, t1, t2, t3))] = true;
    }

    function unsubscribe(uint256 chainId, address c, uint256 t0, uint256 t1, uint256 t2, uint256 t3) external {
        isSubscribed[keccak256(abi.encode(msg.sender, chainId, c, t0, t1, t2, t3))] = false;
    }

    function requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0 memory c) external {
        _callbacks.push(CallbackReq(msg.sender, c.chainId, c.recipient, c.gasLimit, c.payload));
    }

    // ── Test helpers ──
    function subscribed(address s, uint256 chainId, address c, uint256 t0, uint256 t1, uint256 t2, uint256 t3)
        external
        view
        returns (bool)
    {
        return isSubscribed[keccak256(abi.encode(s, chainId, c, t0, t1, t2, t3))];
    }

    function subCount() external view returns (uint256) {
        return _subs.length;
    }

    function callbackCount() external view returns (uint256) {
        return _callbacks.length;
    }

    function callbackAt(uint256 i) external view returns (CallbackReq memory) {
        return _callbacks[i];
    }
}
