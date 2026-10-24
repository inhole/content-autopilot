import { useMutation, useQueryClient } from '@tanstack/react-query'
import { LogOutIcon, ShieldOffIcon } from 'lucide-react'
import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog.tsx'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar.tsx'
import { api } from '@/lib/api.ts'
import { endSession } from '@/lib/queries.ts'

/** Sidebar footer: log out of this browser, or end every session (after a confirmation). */
export function AccountMenu() {
  const client = useQueryClient()
  const [confirmAll, setConfirmAll] = useState(false)
  // Even when the request fails (session already gone, network), this browser is logged out.
  const logout = useMutation({ mutationFn: api.logout, onSettled: () => endSession(client) })
  const logoutAll = useMutation({ mutationFn: api.logoutAll, onSettled: () => endSession(client) })

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip="로그아웃"
            disabled={logout.isPending}
            onClick={() => logout.mutate()}
          >
            <LogOutIcon />
            <span>로그아웃</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton tooltip="모든 세션 끊기" onClick={() => setConfirmAll(true)}>
            <ShieldOffIcon />
            <span>모든 세션 끊기</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <AlertDialog open={confirmAll} onOpenChange={setConfirmAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>모든 세션을 끊을까요?</AlertDialogTitle>
            <AlertDialogDescription>
              이 브라우저를 포함해 로그인된 모든 기기에서 로그아웃돼요. 다시 들어오려면 Telegram
              코드를 새로 받아야 해요.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => logoutAll.mutate()}>
              모두 끊기
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
