import { useEffect, useState } from "react";
import { useStore } from "../store/store.ts";
import { IconLock } from "../lib/icons.tsx";

export function PendingPermissions() {
  const s = useStore();
  const [open, setOpen] = useState(false);
  // Fed by the gateway's durable inbox (polled), so this badge survives a reload
  // and spans EVERY agent — answering goes through the server-side route, which
  // routes to the live agent without needing its SSE connection here. The active
  // session's own prompt shows in-thread, not in this badge.
  const pending = s.inboxItems.filter((it) => it.reqId != null && it.sessionId !== s.activeId);

  useEffect(() => {
    if (!pending.length) setOpen(false);
  }, [pending.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!pending.length) return null;

  return (
    <>
      <button className="icon-btn pending-btn" title="Pending permissions" onClick={() => setOpen((v) => !v)}>
        <IconLock />
        <span className="badge">{pending.length}</span>
      </button>
      {open && (
        <>
          <div className="pending-scrim" onClick={() => setOpen(false)} />
          <div className="pending-menu" role="dialog" aria-label="Pending permissions">
            <div className="pending-head"><IconLock />Permission needed</div>
            {pending.map((item) => {
              const sessionTitle = (item.sessionId && s.sessions[item.sessionId]?.title) || item.sessionId?.slice(0, 8) || item.agentName;
              return (
                <div className="pending-item" key={item.agentName + ":" + item.reqId}>
                  <div className="pending-session">{sessionTitle}</div>
                  <div className="pending-title">{item.title}</div>
                  <div className="pending-actions">
                    {item.options.map((option) => (
                      <button key={option.optionId}
                        className={/allow/.test(option.kind || "") ? "allow" : ""}
                        onClick={() => s.answerInboxItem(item.agentName, item.reqId!, option.optionId)}>
                        {option.name || option.optionId}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
