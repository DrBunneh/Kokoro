// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { AppLayout } from "@/ui/AppLayout";
import { MainMenu } from "@/ui/screens/MainMenu";
import { DecksScreen } from "@/ui/screens/DecksScreen";
import { DecklistsScreen } from "@/ui/screens/DecklistsScreen";

afterEach(cleanup);

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <AppLayout />,
        children: [
          { index: true, element: <MainMenu /> },
          { path: "decks", element: <DecksScreen /> },
          { path: "decks/:deckId/list", element: <DecklistsScreen /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  return render(<RouterProvider router={router} />);
}

describe("UI smoke (jsdom + fake-indexeddb)", () => {
  it("renders the main menu with all four tiles", () => {
    renderAt("/");
    expect(screen.getByText("Inkwell")).toBeDefined();
    for (const label of ["Decks", "Play", "Stats", "Replays"]) {
      expect(screen.getByRole("button", { name: label })).toBeDefined();
    }
  });

  it("loads the Decks screen from Dexie (empty state)", async () => {
    renderAt("/decks");
    await waitFor(() => expect(screen.getByText(/No decks yet/i)).toBeDefined());
    expect(screen.getByRole("button", { name: /New deck/i })).toBeDefined();
  });

  it("imports the supplied decklist on the Decklists screen", async () => {
    // Seed a deck directly via the store-backed DB, then open its list view.
    const { useDecks } = await import("@/state/useDecks");
    const deck = await useDecks.getState().create({ name: "Test" });

    renderAt(`/decks/${deck.id}/list`);
    await waitFor(() => expect(screen.getByDisplayValue("Test")).toBeDefined());

    fireEvent.click(screen.getByText(/Import from text/i));
    const textarea = screen.getByPlaceholderText(/Kida/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "3 Maui - Half-Shark (6-124)\n4 Be Prepared (1-128)" } });
    fireEvent.click(screen.getByRole("button", { name: /Load decklist/i }));

    await waitFor(() => expect(screen.getByText("Maui - Half-Shark")).toBeDefined(), {
      timeout: 8000,
    });
    expect(screen.getByText("Be Prepared")).toBeDefined();
    expect(screen.getByText("7 cards")).toBeDefined();
  });
});
