'use strict';

/**
 * Packet ID maps for Minecraft 1.21.x
 *
 * Protocol versions:
 *   767 → 1.21.0, 1.21.1
 *   768 → 1.21.2, 1.21.3
 *   769 → 1.21.4
 *   770 → 1.21.5
 *   771 → 1.21.6
 *   772 → 1.21.7, 1.21.8
 *   773 → 1.21.9, 1.21.10
 *   774 → 1.21.11
 *
 * We start at 774 (latest) and fall back down on rejection.
 * States: HANDSHAKING, STATUS, LOGIN, CONFIGURATION, PLAY
 */

// Serverbound (client → server)
const SB = {
  HANDSHAKING: {
    HANDSHAKE: 0x00,
  },
  STATUS: {
    STATUS_REQUEST: 0x00,
    PING_REQUEST:   0x01,
  },
  LOGIN: {
    LOGIN_START:          0x00,
    ENCRYPTION_RESPONSE:  0x01,
    LOGIN_ACKNOWLEDGED:   0x03,
  },
  CONFIGURATION: {
    CLIENT_INFORMATION:   0x00,
    FINISH_CONFIGURATION: 0x03,
    PONG:                 0x05,
    KEEPALIVE:            0x04,
  },
  PLAY: {
    CONFIRM_TELEPORT:     0x00,
    CHAT_MESSAGE:         0x06,
    CLIENT_INFORMATION:   0x0A,
    KEEPALIVE:            0x18,
    SET_PLAYER_POS:       0x1A,
    SET_PLAYER_POS_ROT:   0x1B,
    SET_PLAYER_ROT:       0x1C,
    SET_PLAYER_ON_GROUND: 0x1D,
  },
};

// Clientbound (server → client)
const CB = {
  LOGIN: {
    DISCONNECT:           0x00,
    ENCRYPTION_REQUEST:   0x01,
    LOGIN_SUCCESS:        0x02,
    SET_COMPRESSION:      0x03,
    LOGIN_PLUGIN_REQUEST: 0x04,
  },
  CONFIGURATION: {
    COOKIE_REQUEST:        0x00,
    PLUGIN_MESSAGE:        0x01,
    DISCONNECT:            0x02,
    FINISH_CONFIGURATION:  0x03,
    KEEPALIVE:             0x04,
    PING:                  0x05,
    RESET_CHAT:            0x06,
    REGISTRY_DATA:         0x07,
    REMOVE_RESOURCE_PACK:  0x08,
    ADD_RESOURCE_PACK:     0x09,
    STORE_COOKIE:          0x0A,
    TRANSFER:              0x0B,
    FEATURE_FLAGS:         0x0C,
    UPDATE_TAGS:           0x0D,
    KNOWN_PACKS:           0x0E,
    CUSTOM_REPORT_DETAILS: 0x0F,
    SERVER_LINKS:          0x10,
  },
  PLAY: {
    BUNDLE_DELIMITER:     0x00,
    SPAWN_ENTITY:         0x01,
    DISCONNECT:           0x1D,
    KEEPALIVE:            0x26,
    LOGIN:                0x2B,
    PLAYER_POSITION:      0x40,
    SYNCHRONIZE_PLAYER_POSITION: 0x40,
    GAME_EVENT:           0x22,
    PING:                 0x38,
  },
};

module.exports = { SB, CB };
