// O que o cliente recebe de uma Server Action ou de um render de RSC que
// lançou, em produção: a mensagem trocada pelo Next e o digest (hash numérico)
// preservado (#653). "2876531478" vira o código "1bkm1w6".
export function maskedServerError(digest = "2876531478") {
  return Object.assign(
    new Error(
      "An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details.",
    ),
    { digest },
  );
}
