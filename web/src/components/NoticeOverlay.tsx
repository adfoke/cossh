import { useUI } from "../uiStore";
import { Overlay } from "./Overlay";

/** 使用须知：红色警示入口，两条安装/依赖前置条件 */
export function NoticeOverlay() {
  const { overlay, close } = useUI();
  if (overlay !== "notice") return null;
  return (
    <Overlay title="⚠️ 须知" onClose={close} width={520}>
      <ol className="list-decimal space-y-3 pl-5 text-sm leading-7">
        <li>
          本程序依赖 <b>npm</b>，请确认已安装。
        </li>
        <li>这是一个在浏览器画布上开真终端、直接操作服务器的程序。</li>
      </ol>
    </Overlay>
  );
}
