import { useUI } from "../uiStore";
import { Overlay } from "./Overlay";

/** 使用须知：红色警示入口，三条安装/依赖前置条件，措辞与产品要求逐字一致 */
export function NoticeOverlay() {
  const { overlay, close } = useUI();
  if (overlay !== "notice") return null;
  return (
    <Overlay title="⚠️ 须知" onClose={close} width={520}>
      <ol className="list-decimal space-y-3 pl-5 text-sm leading-7">
        <li>
          本程序依赖 <b>npm</b>，请确认已安装。
        </li>
        <li>这是一个用 <b>codex-cli</b> 来操作服务器的程序。</li>
        <li>安装 codex 之后请让 codex 帮忙安装 <b>tmux</b> 程序。</li>
      </ol>
    </Overlay>
  );
}
