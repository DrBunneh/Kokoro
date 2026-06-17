// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { AppLayout } from "@/ui/AppLayout";
import { HotSeatScreen } from "@/ui/screens/HotSeatScreen";
import { useDecks } from "@/state/useDecks";
import { useGame } from "@/state/useGame";

afterEach(() => {
  cleanup();
  useGame.getState().end();
});

function renderHotSeat() {
  const router = createMemoryRouter(
    [{ path: "/", element: <AppLayout />, children: [{ path: "play/hotseat", element: <HotSeatScreen /> }] }],
    { initialEntries: ["/play/hotseat"] },
  );
  return render(<RouterProvider router={router} />);
}

describe("hot-seat board (jsdom)", () => {
  it("sets up two decks, starts, coin-toss → mulligan", async () => {
    // Two real-card decks so the engine's lookup resolves.
    await useDecks.getState().create({ name: "Deck A", cards: [{ id: "6-124", count: 60 }] });
    await useDecks.getState().create({ name: "Deck B", cards: [{ id: "5-157", count: 60 }] });

    renderHotSeat();

    const start = (await screen.findByRole(
      "button",
      { name: /Start game|Loading cards/i },
      { timeout: 8000 },
    )) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false), { timeout: 8000 });
    fireEvent.click(start);

    // Coin toss panel.
    await waitFor(() => expect(screen.getByText(/won the toss/i)).toBeDefined(), { timeout: 8000 });

    // Choose a starting player → mulligan phase.
    const choices = screen.getAllByRole("button", { name: /Deck A|Deck B/ });
    fireEvent.click(choices[0]!);
    await waitFor(() => expect(screen.getByText(/tap cards to bottom/i)).toBeDefined());
  }, 20000);
});
