import { cookies } from "next/headers";
import { openSession, SESSION_COOKIE } from "@/lib/session";
import LoginPage from "@/app/login/page";
export function SessionGate({ children }: { children: React.ReactNode }) {
  return openSession(cookies().get(SESSION_COOKIE)?.value) === null ? <LoginPage /> : children;
}
