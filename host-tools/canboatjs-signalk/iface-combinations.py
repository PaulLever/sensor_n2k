#!/usr/bin/env python3
"""
iface-combinations.py — report the WiFi driver's "valid interface
combinations" as JSON, for netconfig-server.js's 2.4GHz-bridge capability
gate.

This is the same information `iw list` prints under "valid interface
combinations", read straight from the kernel over generic netlink
(NL80211_CMD_GET_WIPHY -> NL80211_ATTR_INTERFACE_COMBINATIONS).

Why not just shell out to `iw`? Because `iw` is not installed on this
board's stock image, and the whole point of the capability gate is that it
must give a real answer rather than "unknown" — a gate that always fails
open-ended is a gate nobody trusts. netconfig-server.js still prefers
`iw list` when it is present; this is the fallback that makes the check
work out of the box.

Python rather than Node because Node cannot open an AF_NETLINK socket
without a native addon, and this project takes no new dependencies.
Python 3 is already present on the board and already used elsewhere in
host-tools/ (n2k_test.py, bench.py, can_spi_bridge.py).

Needs no privileges — GET_WIPHY is world-readable.

Usage:
    python3 iface-combinations.py            # human-readable, iw-like
    python3 iface-combinations.py --json     # machine-readable

Verified on the Arduino UNO Q (phy0) — see docs/NETWORK-SETUP.md.
"""

import json
import os
import socket
import struct
import sys

NETLINK_GENERIC = 16
GENL_ID_CTRL = 0x10
CTRL_CMD_GETFAMILY = 3
CTRL_ATTR_FAMILY_ID = 1
CTRL_ATTR_FAMILY_NAME = 2

NLM_F_REQUEST = 1
NLM_F_DUMP = 0x300
NLMSG_ERROR = 2
NLMSG_DONE = 3

NL80211_CMD_GET_WIPHY = 1
ATTR_WIPHY_NAME = 2
ATTR_IFACE_COMBINATIONS = 120
# Without this flag modern kernels truncate the wiphy dump and the
# combinations attribute never arrives.
ATTR_SPLIT_WIPHY_DUMP = 174

COMB_LIMITS = 1
COMB_MAXNUM = 2
COMB_NUM_CHANNELS = 4
LIMIT_MAX = 1
LIMIT_TYPES = 2

# nl80211_iftype, spelled the way `iw list` spells them so the output is
# directly comparable with the documented tool.
IFTYPES = {
    0: 'unspecified', 1: 'IBSS', 2: 'managed', 3: 'AP', 4: 'AP/VLAN',
    5: 'WDS', 6: 'monitor', 7: 'mesh point', 8: 'P2P-client',
    9: 'P2P-GO', 10: 'P2P-device', 11: 'outside context of a BSS',
    12: 'NAN',
}


def nla(attr_type, payload=b''):
    length = 4 + len(payload)
    return struct.pack('=HH', length, attr_type) + payload + b'\0' * ((4 - length % 4) % 4)


def parse_attrs(buf):
    """-> [(type, payload)]. Masks off NLA_F_NESTED/NLA_F_NET_BYTEORDER."""
    out = []
    i = 0
    while i + 4 <= len(buf):
        length, atype = struct.unpack_from('=HH', buf, i)
        if length < 4:
            break
        out.append((atype & 0x3fff, buf[i + 4:i + length]))
        i += (length + 3) & ~3
    return out


def send_genl(sock, family, cmd, flags, payload=b'', seq=1):
    genl = struct.pack('=BBH', cmd, 1, 0) + payload
    sock.send(struct.pack('=IHHII', 16 + len(genl), family, flags, seq, 0) + genl)


def recv_one(sock):
    data = sock.recv(65536)
    length, mtype = struct.unpack_from('=IHHII', data, 0)[:2]
    if mtype == NLMSG_ERROR:
        err = struct.unpack_from('=i', data, 16)[0]
        raise OSError(-err, os.strerror(-err))
    return data[16:length]


def recv_dump(sock):
    """Collect every message of a NLM_F_DUMP reply up to NLMSG_DONE."""
    bodies = []
    while True:
        data = sock.recv(65536)
        i = 0
        while i + 16 <= len(data):
            length, mtype = struct.unpack_from('=IHHII', data, i)[:2]
            body = data[i + 16:i + length]
            if mtype == NLMSG_DONE:
                return bodies
            if mtype == NLMSG_ERROR:
                err = struct.unpack_from('=i', body, 0)[0]
                if err:
                    raise OSError(-err, os.strerror(-err))
                return bodies
            bodies.append(body)
            i += (length + 3) & ~3


def supports_ap_sta(combo):
    """Mirror of comboSupportsApSta() in netconfig-server.js — keep the two
    in step: either one limit permits both types with room for 2, or two
    distinct limits cover them separately."""
    if combo['total'] is not None and combo['total'] < 2:
        return False
    for g in combo['groups']:
        if 'AP' in g['types'] and 'managed' in g['types'] and g['max'] >= 2:
            return True
    aps = [i for i, g in enumerate(combo['groups']) if 'AP' in g['types'] and g['max'] >= 1]
    stas = [i for i, g in enumerate(combo['groups']) if 'managed' in g['types'] and g['max'] >= 1]
    return any(a != b for a in aps for b in stas)


def read_combinations():
    sock = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, NETLINK_GENERIC)
    try:
        sock.bind((0, 0))
        sock.settimeout(10)

        send_genl(sock, GENL_ID_CTRL, CTRL_CMD_GETFAMILY, NLM_F_REQUEST,
                  nla(CTRL_ATTR_FAMILY_NAME, b'nl80211\0'))
        family = None
        for atype, val in parse_attrs(recv_one(sock)[4:]):
            if atype == CTRL_ATTR_FAMILY_ID:
                family = struct.unpack_from('=H', val, 0)[0]
        if family is None:
            raise RuntimeError('nl80211 generic-netlink family not found (no WiFi driver loaded?)')

        send_genl(sock, family, NL80211_CMD_GET_WIPHY, NLM_F_REQUEST | NLM_F_DUMP,
                  nla(ATTR_SPLIT_WIPHY_DUMP), seq=2)

        phy = None
        raw_combos = []
        for body in recv_dump(sock):
            for atype, val in parse_attrs(body[4:]):
                if atype == ATTR_WIPHY_NAME:
                    phy = val.rstrip(b'\0').decode('utf-8', 'replace')
                elif atype == ATTR_IFACE_COMBINATIONS:
                    for _idx, cbuf in parse_attrs(val):
                        raw_combos.append(cbuf)
    finally:
        sock.close()

    combos = []
    for cbuf in raw_combos:
        groups, maxnum, nchan = [], None, None
        for atype, val in parse_attrs(cbuf):
            if atype == COMB_LIMITS:
                for _i, lbuf in parse_attrs(val):
                    lmax, types = None, []
                    for ltype, lval in parse_attrs(lbuf):
                        if ltype == LIMIT_MAX:
                            lmax = struct.unpack_from('=I', lval, 0)[0]
                        elif ltype == LIMIT_TYPES:
                            types = [IFTYPES.get(t, str(t)) for t, _ in parse_attrs(lval)]
                    groups.append({'types': types, 'max': lmax if lmax is not None else 0})
            elif atype == COMB_MAXNUM:
                maxnum = struct.unpack_from('=I', val, 0)[0]
            elif atype == COMB_NUM_CHANNELS:
                nchan = struct.unpack_from('=I', val, 0)[0]

        raw = ', '.join('#{ %s } <= %d' % (', '.join(g['types']), g['max']) for g in groups)
        raw += ', total <= %s, #channels <= %s' % (maxnum, nchan)
        combos.append({'raw': raw, 'groups': groups, 'total': maxnum, 'channels': nchan})

    return {'phy': phy, 'combos': combos}


def main():
    try:
        result = read_combinations()
    except Exception as exc:                       # noqa: BLE001 - reported, not raised
        if '--json' in sys.argv:
            print(json.dumps({'error': str(exc), 'combos': []}))
        else:
            print('error: %s' % exc, file=sys.stderr)
        return 1

    if '--json' in sys.argv:
        print(json.dumps(result))
        return 0

    print('phy: %s' % result['phy'])
    print('valid interface combinations:')
    if not result['combos']:
        print('\t (none advertised by this driver)')
    for combo in result['combos']:
        print('\t * %s%s' % (combo['raw'], '   [AP + station OK]' if supports_ap_sta(combo) else ''))
    print()
    print('concurrent AP + station: %s'
          % ('SUPPORTED' if any(supports_ap_sta(c) for c in result['combos']) else 'NOT SUPPORTED'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
