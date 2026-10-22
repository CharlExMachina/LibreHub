# Find serialized FileDescriptorProto blobs in a binary and render them as .proto-ish text.
import sys, re
from google.protobuf import descriptor_pb2
data = open(sys.argv[1], 'rb').read()
out = {}
for m in re.finditer(rb'\x0a([\x01-\x7f])([A-Za-z0-9_/.\-]+\.proto)', data):
    if m.group(1)[0] != len(m.group(2)): continue
    start = m.start()
    # try increasing lengths until the parse stops changing; descriptors are self-delimiting only via the container, so bisect by trying ends
    best = None
    for end in range(start + 64, min(len(data), start + 400000), 16):
        pass
    # Parse greedily: protobuf parser tolerates trailing garbage poorly, so scan field by field.
    i = start; n = len(data)
    def varint(i):
        r = s = 0
        while True:
            b = data[i]; i += 1; r |= (b & 0x7f) << s; s += 7
            if b < 0x80: return r, i
    ok_end = start
    try:
        while i < n:
            key, j = varint(i); fn, wt = key >> 3, key & 7
            if fn < 1 or fn > 12: break
            if wt == 2:
                ln, j = varint(j); j += ln
            elif wt == 0:
                _, j = varint(j)
            else: break
            if j > n: break
            fd = descriptor_pb2.FileDescriptorProto()
            fd.ParseFromString(data[start:j])
            i = ok_end = j
    except Exception:
        pass
    fd = descriptor_pb2.FileDescriptorProto()
    try: fd.ParseFromString(data[start:ok_end])
    except Exception: continue
    if fd.name and (fd.message_type or fd.enum_type): out[fd.name] = fd
fs = descriptor_pb2.FileDescriptorSet(file=list(out.values()))
open(sys.argv[2], 'wb').write(fs.SerializeToString())
print(len(out), 'files'); print('\n'.join(sorted(out)[:400]))
