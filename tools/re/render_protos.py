import sys, os
from google.protobuf import descriptor_pb2
fs = descriptor_pb2.FileDescriptorSet(); fs.ParseFromString(open(sys.argv[1],'rb').read())
T = {1:'double',2:'float',3:'int64',4:'uint64',5:'int32',6:'fixed64',7:'fixed32',8:'bool',9:'string',12:'bytes',13:'uint32',15:'sfixed32',16:'sfixed64',17:'sint32',18:'sint64'}
def enum(e, ind):
    s = f"{ind}enum {e.name} {{\n" + ''.join(f"{ind}  {v.name} = {v.number};\n" for v in e.value) + f"{ind}}}\n"; return s
def msg(m, ind):
    s = f"{ind}message {m.name} {{\n"
    for e in m.enum_type: s += enum(e, ind+'  ')
    for n in m.nested_type:
        if n.options.map_entry: continue
        s += msg(n, ind+'  ')
    for f in m.field:
        t = T.get(f.type) or f.type_name.lstrip('.')
        lab = 'repeated ' if f.label == 3 else ''
        oo = f"  // oneof {m.oneof_decl[f.oneof_index].name}" if f.HasField('oneof_index') else ''
        s += f"{ind}  {lab}{t} {f.name} = {f.number};{oo}\n"
    return s + f"{ind}}}\n"
outdir = sys.argv[2]
for fd in fs.file:
    p = os.path.join(outdir, fd.name); os.makedirs(os.path.dirname(p), exist_ok=True)
    s = f"// {fd.name}\nsyntax = \"{fd.syntax or 'proto2'}\";\npackage {fd.package};\n" + ''.join(f'import "{d}";\n' for d in fd.dependency) + '\n'
    s += ''.join(enum(e,'') for e in fd.enum_type) + ''.join(msg(m,'') for m in fd.message_type)
    open(p,'w').write(s)
