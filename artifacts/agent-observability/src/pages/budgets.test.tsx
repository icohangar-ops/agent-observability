import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";

const useListBudgets = vi.fn();
const useListDepartments = vi.fn();
const useListModels = vi.fn();
const useSetBudget = vi.fn();
const useDeleteBudget = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useListBudgets: (...args: unknown[]) => useListBudgets(...args),
  useListDepartments: (...args: unknown[]) => useListDepartments(...args),
  useListModels: (...args: unknown[]) => useListModels(...args),
  useSetBudget: (...args: unknown[]) => useSetBudget(...args),
  useDeleteBudget: (...args: unknown[]) => useDeleteBudget(...args),
  getListBudgetsQueryKey: () => ["budgets"],
  getListDepartmentsQueryKey: () => ["departments"],
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import Budgets from "./budgets";
import { Toaster } from "@/components/ui/toaster";

type MutationOptions = { mutation?: { onSuccess?: () => void; onError?: (err: unknown) => void } };

describe("Budgets save toast auto-dismiss", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useListBudgets.mockReturnValue({ data: [], isLoading: false });
    useListDepartments.mockReturnValue({
      data: [{ id: "dept-1", name: "Engineering" }],
    });
    useListModels.mockReturnValue({ data: [] });
    // A real save would resolve asynchronously; invoke onSuccess synchronously
    // so the test focuses purely on the toast's own auto-dismiss behavior.
    useSetBudget.mockImplementation((options?: MutationOptions) => ({
      mutate: () => options?.mutation?.onSuccess?.(),
      isPending: false,
    }));
    useDeleteBudget.mockReturnValue({ mutate: vi.fn(), isPending: false });
  });

  it("auto-dismisses the 'Budget saved' toast after the default window when the user does nothing", () => {
    // The save toast sets no explicit duration, so it depends entirely on the
    // shared toast component's default auto-dismiss. Guard that a regression to
    // that default can't leave the confirmation pinned on screen forever.
    render(
      <>
        <Budgets />
        <Toaster />
      </>,
    );

    // Fill in a valid budget (department + positive amount) so handleSave
    // reaches the mutation and fires the "Budget saved" toast on success.
    fireEvent.change(screen.getByTestId("input-amount"), { target: { value: "100" } });
    fireEvent.click(screen.getByTestId("select-department"));
    fireEvent.click(screen.getByText("Engineering"));

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTestId("button-save-budget"));
      expect(screen.getByText("Budget saved")).toBeInTheDocument();

      // Just before the default auto-dismiss window elapses it is still shown.
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(screen.getByText("Budget saved")).toBeInTheDocument();

      // Once the default window passes, the toast dismisses itself.
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.queryByText("Budget saved")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
