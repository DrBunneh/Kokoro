import { Outlet, useLocation, useNavigate } from "react-router-dom";

/** App shell: a back affordance plus the routed screen. Mobile-first, full-height. */
export function AppLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const atRoot = pathname === "/";
  // Board/play screens use the full (landscape) width; menus stay phone-width.
  const wide = pathname.startsWith("/play/");

  return (
    <div className={`mx-auto flex h-full flex-col ${wide ? "max-w-none" : "max-w-md"}`}>
      {!atRoot && (
        <header className="flex items-center p-2">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="min-h-tap min-w-tap rounded-lg px-3 text-sm text-slate-300 hover:bg-white/5"
          >
            ← Back
          </button>
        </header>
      )}
      <main className={`flex-1 overflow-y-auto ${wide ? "px-3 pb-3" : "p-4"}`}>
        <Outlet />
      </main>
    </div>
  );
}
