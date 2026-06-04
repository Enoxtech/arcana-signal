// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract DearArcMessages {
    event MessageCreated(
        address indexed sender,
        string text,
        uint8 messageType,
        uint8 intensity,
        uint256 timestamp
    );

    function createMessage(
        string calldata text,
        uint8 messageType,
        uint8 intensity
    ) external {
        require(bytes(text).length > 0, "EMPTY_MESSAGE");
        require(messageType < 4, "INVALID_TYPE");
        require(intensity >= 1 && intensity <= 5, "INVALID_INTENSITY");

        emit MessageCreated(
            msg.sender,
            text,
            messageType,
            intensity,
            block.timestamp
        );
    }
}
