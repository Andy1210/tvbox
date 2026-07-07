// Map an hour-of-day to a greeting translation key (resolved via i18n).
export type GreetingKey = "night" | "morning" | "day" | "evening";

export function greetingKey(hour: number): GreetingKey {
  if (hour < 5) return "night";
  if (hour < 10) return "morning";
  if (hour < 18) return "day";
  return "evening";
}
