"use client";

import { Button } from "@/components/ui/button";

const DAYS = [
  { label: "S", value: 0, name: "Sun" },
  { label: "M", value: 1, name: "Mon" },
  { label: "T", value: 2, name: "Tue" },
  { label: "W", value: 3, name: "Wed" },
  { label: "T", value: 4, name: "Thu" },
  { label: "F", value: 5, name: "Fri" },
  { label: "S", value: 6, name: "Sat" },
];

export type WeeklySchedule = { days: number[]; time: string };
export type IntervalSchedule = { every: number };
export type Schedule = WeeklySchedule | IntervalSchedule;

function isInterval(s: Schedule): s is IntervalSchedule {
  return "every" in s;
}

export function parseSchedule(raw: string | null): Schedule {
  if (!raw) return { days: [1, 2, 3, 4, 5], time: "09:00" };
  try {
    const parsed = JSON.parse(raw);
    if ("every" in parsed) return { every: parsed.every };
    if (parsed.days && parsed.time) return parsed;
  } catch {}
  return { days: [1, 2, 3, 4, 5], time: "09:00" };
}

export function serializeSchedule(schedule: Schedule): string {
  return JSON.stringify(schedule);
}

export function formatSchedule(schedule: Schedule): string {
  if (isInterval(schedule)) {
    if (schedule.every >= 60 && schedule.every % 60 === 0) {
      const hrs = schedule.every / 60;
      return `Every ${hrs} ${hrs === 1 ? "hour" : "hours"}`;
    }
    return `Every ${schedule.every} minutes`;
  }

  const dayNames = schedule.days
    .sort((a, b) => a - b)
    .map((d) => DAYS.find((day) => day.value === d)?.name)
    .filter(Boolean);

  const [h, m] = schedule.time.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const timeStr = `${displayHour}:${String(m).padStart(2, "0")} ${period}`;

  const sorted = schedule.days.slice().sort((a, b) => a - b);
  if (dayNames.length === 7) return `Daily at ${timeStr}`;
  if (sorted.length === 5 && sorted.join() === "1,2,3,4,5") return `Weekdays at ${timeStr}`;
  if (sorted.length === 2 && sorted.join() === "0,6") return `Weekends at ${timeStr}`;
  if (dayNames.length === 0) return `No days selected`;
  return `${dayNames.join(", ")} at ${timeStr}`;
}

export function SchedulePicker({
  schedule,
  onChange,
}: {
  schedule: Schedule;
  onChange: (schedule: Schedule) => void;
}) {
  const interval = isInterval(schedule);

  return (
    <div className="space-y-3">
      <div className="flex gap-1">
        <Button
          type="button"
          variant={!interval ? "default" : "outline"}
          size="sm"
          className="text-xs"
          onClick={() => {
            if (interval) onChange({ days: [1, 2, 3, 4, 5], time: "09:00" });
          }}
        >
          Weekly
        </Button>
        <Button
          type="button"
          variant={interval ? "default" : "outline"}
          size="sm"
          className="text-xs"
          onClick={() => {
            if (!interval) onChange({ every: 60 });
          }}
        >
          Interval
        </Button>
      </div>

      {interval ? (
        <div>
          <label htmlFor="schedule-every-minutes" className="text-xs text-muted-foreground">
            Every (minutes)
          </label>
          <input
            id="schedule-every-minutes"
            type="number"
            min={1}
            value={schedule.every}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (v > 0) onChange({ every: v });
            }}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
      ) : (
        <>
          <div>
            <span className="text-xs text-muted-foreground">Days</span>
            <div className="flex gap-1 mt-1">
              {DAYS.map((day) => (
                <Button
                  key={day.value}
                  type="button"
                  variant={
                    (schedule as WeeklySchedule).days.includes(day.value) ? "default" : "outline"
                  }
                  size="sm"
                  className="h-8 w-8 p-0 text-xs"
                  onClick={() => {
                    const ws = schedule as WeeklySchedule;
                    const newDays = ws.days.includes(day.value)
                      ? ws.days.filter((d) => d !== day.value)
                      : [...ws.days, day.value].sort((a, b) => a - b);
                    onChange({ ...ws, days: newDays });
                  }}
                >
                  {day.label}
                </Button>
              ))}
            </div>
          </div>
          <div>
            <label htmlFor="schedule-weekly-time" className="text-xs text-muted-foreground">
              Time
            </label>
            <input
              id="schedule-weekly-time"
              type="time"
              value={(schedule as WeeklySchedule).time}
              onChange={(e) => onChange({ ...(schedule as WeeklySchedule), time: e.target.value })}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
        </>
      )}
    </div>
  );
}
