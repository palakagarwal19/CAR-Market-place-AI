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
      <h1 className="mb-4 text-2xl font-bold">Sign in to Vehiql</h1>
      <p className="mb-6 text-gray-600">
        Use the temporary demo credentials shown by the deployment script.
      </p>
      <DemoLoginForm redirectTo={redirectTo} />
      <p className="mt-6 text-sm text-gray-600">
        Demo account access is managed by the project owner.
      </p>
    </div>
  );
}
