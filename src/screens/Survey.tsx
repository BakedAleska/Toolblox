import { CircleAlert, ClipboardList } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { bridge, describeError, isDemo } from "@/bridge";
import { IconButton, Modal } from "@/shared";

/** Optional beta survey. Remove after the beta. */
const surveyKey = "beta-survey";

function readSurvey() {
  try { return localStorage.getItem(surveyKey); } catch { return null; }
}

function writeSurvey(value: "seen" | "sent") {
  try { localStorage.setItem(surveyKey, value); } catch { /* The survey opens again next time. */ }
}

/** Opens once on first launch, then stays as a header button until answers are sent. */
export function useSurvey(notify: (message: string) => void) {
  const [stage, setStage] = useState(() => isDemo() ? "sent" : readSurvey());
  const [open, setOpen] = useState(stage === null);
  const [rating, setRating] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  const close = () => { setOpen(false); if (stage === null) { writeSurvey("seen"); setStage("seen"); } };
  const send = async () => {
    setBusy(true);
    try {
      await bridge.submitSurvey(Number(rating), comment);
      writeSurvey("sent");
      setStage("sent");
      setOpen(false);
      notify("Thanks. Your answers were sent.");
    } catch (error) { notify(describeError(error)); }
    finally { setBusy(false); }
  };

  const button = stage !== "sent" && <>
    <IconButton label="Help me improve! Beta survey" className="relative text-muted-foreground" onClick={() => setOpen(true)}>
      <ClipboardList />
      <CircleAlert className="absolute top-1 right-1 size-3 fill-background text-success" strokeWidth={2.5} aria-hidden="true" />
    </IconButton>
    <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
  </>;
  const title = <span className="flex items-center gap-2">Help me improve!<Badge variant="secondary">Beta survey</Badge></span>;
  const dialog = <Modal open={open} close={close} title={title} description="Two quick questions about this beta." action="Send" submit={() => void send()} busy={busy} disabled={!rating}>
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p id="survey-rating" className="text-sm font-medium">How useful is Toolblox?</p>
        <ToggleGroup variant="outline" value={rating ? [rating] : []} onValueChange={(values) => setRating(values[0] ?? "")} aria-labelledby="survey-rating" className="w-full">
          {["1", "2", "3", "4", "5"].map((value) => <ToggleGroupItem key={value} value={value} className="flex-1">{value}</ToggleGroupItem>)}
        </ToggleGroup>
        <div className="flex justify-between text-xs text-muted-foreground" aria-hidden="true"><span>Not useful</span><span>Very useful</span></div>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="survey-comment" className="text-sm font-medium">Anything to add? <span className="font-normal text-muted-foreground">Optional</span></label>
        <Textarea id="survey-comment" rows={2} maxLength={2000} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="What works, what doesn't, what's missing" className="resize-none" />
        <p className="text-xs text-muted-foreground">Only these answers are sent, to Google Forms.</p>
      </div>
    </div>
  </Modal>;
  return { button, dialog };
}
