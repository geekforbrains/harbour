"use client";

import { Check, Copy, Link2, Plus, Trash2, User as UserIcon } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader, PageLoading } from "@/components/app/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { mutationErrorMessage } from "@/lib/hooks/mutation-error";
import {
  type SetPasswordLink,
  type UserRow,
  useCreateUser,
  useDeleteUser,
  useSetPasswordLink,
  useUsers,
} from "@/lib/hooks/use-users";

export default function UsersPage() {
  const { data: users = [], isLoading } = useUsers();

  const [showNew, setShowNew] = useState(false);
  const [link, setLink] = useState<{ user: SetPasswordLink["user"]; url: string } | null>(null);

  if (isLoading) {
    return <PageLoading />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        align="start"
        title="Users"
        subtitle="Dashboard accounts. Every user has full access."
        actions={
          <Button onClick={() => setShowNew(true)}>
            <Plus className="h-4 w-4 mr-2" /> New User
          </Button>
        }
      />

      {users.length === 0 ? (
        <EmptyState>No users.</EmptyState>
      ) : (
        <div className="space-y-2">
          {users.map((u) => (
            <UserCard key={u.id} user={u} onLink={setLink} />
          ))}
        </div>
      )}

      <NewUserDialog open={showNew} onOpenChange={setShowNew} onLink={setLink} />
      <LinkDialog link={link} onOpenChange={(o) => !o && setLink(null)} />
    </div>
  );
}

function UserCard({
  user,
  onLink,
}: {
  user: UserRow;
  onLink: (l: { user: SetPasswordLink["user"]; url: string }) => void;
}) {
  const deleteUser = useDeleteUser();
  const setPasswordLink = useSetPasswordLink();

  const [confirmDelete, setConfirmDelete] = useState(false);

  async function generateLink() {
    const res = await setPasswordLink.mutateAsync(user.id);
    onLink({ user: res.user, url: res.url });
  }

  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
          <UserIcon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">{user.display_name}</span>
            {user.pending && (
              <Badge
                variant="outline"
                className="text-amber-600 dark:text-amber-400 border-amber-500/40"
              >
                Pending — link not used
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground">{user.email}</div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={generateLink}
            disabled={setPasswordLink.isPending}
          >
            <Link2 className="h-3.5 w-3.5 mr-1.5" />
            {user.pending ? "Set-password link" : "Reset link"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
            title="Delete user"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <Dialog
        open={confirmDelete}
        onOpenChange={(o) => {
          setConfirmDelete(o);
          if (!o) deleteUser.reset();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete user</DialogTitle>
            <DialogDescription>
              Delete {user.display_name} ({user.email})? This removes their account. This can&apos;t
              be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteUser.isError && (
            <p className="text-xs text-destructive">
              {mutationErrorMessage(deleteUser.error, "Failed to delete user")}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                deleteUser.mutate(user.id, { onSuccess: () => setConfirmDelete(false) })
              }
              disabled={deleteUser.isPending}
            >
              {deleteUser.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NewUserDialog({
  open,
  onOpenChange,
  onLink,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onLink: (l: { user: SetPasswordLink["user"]; url: string }) => void;
}) {
  const createUser = useCreateUser();
  const setPasswordLink = useSetPasswordLink();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");

  function reset() {
    setEmail("");
    setDisplayName("");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    const created = await createUser.mutateAsync({
      email: email.trim(),
      displayName: displayName.trim(),
    });
    // Immediately mint a set-password link so the operator can hand it over.
    const linkRes = await setPasswordLink.mutateAsync(created.id);
    reset();
    onOpenChange(false);
    onLink({ user: linkRes.user, url: linkRes.url });
  }

  const busy = createUser.isPending || setPasswordLink.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New User</DialogTitle>
          <DialogDescription>
            Creates the account with no password. You&apos;ll get a one-time set-password link to
            hand over.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="space-y-2">
            <Label>Email</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="person@example.com"
              autoFocus
              required
            />
          </div>
          <div className="space-y-2">
            <Label>Display name</Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Jane Doe"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating..." : "Create user"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LinkDialog({
  link,
  onOpenChange,
}: {
  link: { user: SetPasswordLink["user"]; url: string } | null;
  onOpenChange: (o: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);

  function copy() {
    if (!link) return;
    navigator.clipboard.writeText(link.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Dialog open={!!link} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set-password link</DialogTitle>
          <DialogDescription>
            Send this single-use link to <span className="font-medium">{link?.user.email}</span>{" "}
            however you normally reach them — chat, email, or in person. It expires in 24 hours and
            can only be used once. It won&apos;t be shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input readOnly value={link?.url ?? ""} className="font-mono text-xs" />
          <Button variant="outline" onClick={copy}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
