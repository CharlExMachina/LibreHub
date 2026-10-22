# LLDB breakpoint callback: log every HID output report the agent sends, then keep running.
import lldb, time
LOG = open('/tmp/agent-out.log', 'a', buffering=1)
def on_set_report(frame, bp_loc, extra, internal_dict):
    reg = lambda r: frame.FindRegister(r).GetValueAsUnsigned()
    rid, ptr, n = reg('x2'), reg('x3'), reg('x4')
    err = lldb.SBError()
    data = frame.GetThread().GetProcess().ReadMemory(ptr, min(n, 64), err) if ptr else b''
    if data:
        b = bytes(data); end = len(b)
        while end > 6 and b[end - 1] == 0: end -= 1
        LOG.write('%.3f OUT rid=%02x %s\n' % (time.time(), rid, ' '.join('%02x' % x for x in b[:end])))
    return False
def __lldb_init_module(debugger, internal_dict):
    for fn in ('IOHIDDeviceSetReport', 'IOHIDDeviceSetReportWithCallback'):
        bp = debugger.GetSelectedTarget().BreakpointCreateByName(fn)
        bp.SetScriptCallbackFunction('hidtrace.on_set_report', lldb.SBStructuredData())
        bp.SetAutoContinue(True)
