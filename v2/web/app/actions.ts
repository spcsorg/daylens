"use server";

import { redirect } from "next/navigation";
import { devSignInEnabled, endSession, startSession } from "@/lib/auth";

export async function signIn(memberId: string) {
  if (!devSignInEnabled()) throw new Error("The dev sign-in is off");
  await startSession(memberId);
  redirect("/overview");
}

export async function signOut() {
  await endSession();
  redirect("/sign-in");
}
