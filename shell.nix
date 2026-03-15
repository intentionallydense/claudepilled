{ pkgs ? import <nixpkgs> {} }:

let
  python = pkgs.python313;
  pythonPkgs = python.pkgs;
in
pkgs.mkShell {
  packages = [
    (python.withPackages (ps: with ps; [
      anthropic
      openai
      fastapi
      uvicorn
      python-dotenv
      pydantic
      websockets
      feedparser
      python-multipart
      pymupdf
      setuptools
      wheel
    ]))
  ];

  shellHook = ''
    export PYTHONPATH="${toString ./.}:$PYTHONPATH"
    echo "llm-interface dev shell ready"
    echo "Run: python -m llm_interface.server"
  '';
}
