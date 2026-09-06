import type { ReactNode } from "react";
import { Modal } from "@heroui/react";

/** HeroUI Modal 包装的轻量弹层 */
export function Overlay({
  title,
  onClose,
  children,
  width = 460,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const size = width <= 420 ? "sm" : width <= 500 ? "md" : width <= 580 ? "lg" : "full";

  return (
    <Modal.Root isOpen onOpenChange={(open) => !open && onClose()}>
      <Modal.Backdrop>
        <Modal.Container placement="center" size={size}>
          <Modal.Dialog style={{ maxWidth: width }}>
            <Modal.Header>
              <Modal.Heading>{title}</Modal.Heading>
              <Modal.CloseTrigger aria-label="关闭" />
            </Modal.Header>
            <Modal.Body className="max-h-[70vh] overflow-y-auto">{children}</Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  );
}
