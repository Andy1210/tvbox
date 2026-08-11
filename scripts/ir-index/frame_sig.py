#!/usr/bin/env python3
"""Hash the FRAME each code entry encodes to, for scripts/ir-index/build.js.

Reads one JSON object per line ({"entry": {...}}) and writes one hash per line, empty
for an entry this box could not send. Two databases write the same waveform down in
different ways - an irdb `NEC1 4,-1,8` row and a Flipper `NEC addr 04 cmd 08` block
are the same frame - so the frame is what the index merges devices by, and the
encoders that produce it are the ones the remote is programmed from.

Batched over stdin rather than run per entry: there are ~40k rows across both
databases, and that is 40k python starts otherwise.
"""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "remote"))

import flipper_protocols  # noqa: E402
import ir_protocols  # noqa: E402


def encoded(entry):
    if "irdb" in entry:
        i = entry["irdb"]
        return ir_protocols.encode(i["protocol"], i["device"], i.get("subdevice", -1), i["function"])
    if "flipper" in entry:
        f = entry["flipper"]
        return flipper_protocols.encode(f["protocol"], f.get("address"), f.get("command"))
    if "raw" in entry:
        raw = [int(v) for v in entry["raw"]]
        if not raw:
            raise ValueError("empty raw code")
        return {"frequency": int(entry["frequency"]), "raw": raw}
    raise ValueError("entry carries no code")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            frame = encoded(json.loads(line)["entry"])
            body = "%d|%s" % (frame["frequency"], ",".join(str(v) for v in frame["raw"]))
            print(hashlib.sha1(body.encode()).hexdigest()[:16], flush=False)
        except Exception:
            # An unencodable code still belongs in the index - the picker greys it out
            # and says which protocol - so this is a blank line, not an exit.
            print("", flush=False)
    sys.stdout.flush()


if __name__ == "__main__":
    main()
