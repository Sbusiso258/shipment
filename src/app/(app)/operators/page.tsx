import { redirect } from "next/navigation";

/**
 * "Operators" is what the sidebar calls the team.
 *
 * A redirect rather than a second copy of the screen: one page, one set of
 * actions, one place where a role change is written. `/team` stays because
 * links to it exist and because "team" is what the data is — people with
 * roles, not all of whom are operators.
 */
export default function OperatorsPage() {
  redirect("/team");
}
