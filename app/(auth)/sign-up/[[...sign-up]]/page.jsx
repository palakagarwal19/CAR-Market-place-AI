import { DemoLoginForm } from "@/components/demo-login-form";

export default async function Page({ searchParams }) {
  const params = await searchParams;
  const requestedRedirect = params?.redirect;
  const redirectTo =
    typeof requestedRedirect === "string" &&
    requestedRedirect.startsWith("/") &&
    !requestedRedirect.startsWith("//")
      ? requestedRedirect
      : "/";

  return (
    <div className="rounded-lg border bg-white p-8 text-center shadow-sm">
      <h1 className="mb-4 text-2xl font-bold">Demo access</h1>
      <p className="mb-6 text-gray-600">
        This HTTP demo uses one temporary shared project account. The project
        owner can provide its credentials.
      </p>
      <DemoLoginForm redirectTo={redirectTo} />
    </div>
  );
}
