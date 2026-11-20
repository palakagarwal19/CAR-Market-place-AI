"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function DemoLoginForm({ redirectTo = "/" }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    setPending(true);
    setError("");

    try {
      const formData = new FormData(event.currentTarget);
      const result = await signIn("credentials", {
        email: formData.get("email"),
        password: formData.get("password"),
        redirect: false,
      });

      if (!result || result.error) {
        setError("The demo email or password is incorrect.");
        return;
      }

      router.replace(redirectTo);
      router.refresh();
    } catch (signInError) {
      console.error("Demo sign-in failed:", signInError);
      setError("Unable to sign in. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 text-left">
      <label className="block text-sm font-medium text-gray-700">
        Demo email
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          maxLength={254}
          className="mt-1 w-full rounded-md border px-3 py-2"
        />
      </label>
      <label className="block text-sm font-medium text-gray-700">
        Demo password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={256}
          className="mt-1 w-full rounded-md border px-3 py-2"
        />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Signing in..." : "Sign in to demo"}
      </Button>
      <p className="text-xs leading-relaxed text-amber-800">
        Demo only: this site uses unencrypted HTTP. Do not enter real or reused
        passwords.
      </p>
    </form>
  );
}
